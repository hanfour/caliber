// 3-layer account scheduler (Plan 5A Part 7).
//
// Replaces the single-layer `selectAccounts` priority chain used by 4A's
// `failoverLoop`. Three layers in priority order:
//
//   Layer 1 — `previous_response_id` sticky (Codex CLI multi-turn)
//   Layer 2 — `session_hash` sticky        (Claude Code conversations)
//   Layer 3 — load_balance with EWMA       (cold path / new sessions)
//
// Plus a "forced" path used when callers already know which account to
// hit (e.g. probeAccount). Sticky layers require both a `groupId`
// (introduced in Plan 5A migration 0008) and Redis. When either is
// absent — e.g. legacy api-keys without `group_id`, or unit tests with
// no Redis client — we fall through to Layer 3 directly. This preserves
// all 4A behaviour for callers that haven't been migrated to group
// context yet (Part 8 wires `groupId` into the routes).
//
// Concurrency-slot acquisition stays in the caller's `attempt` callback
// for now (matches 4A); Part 8 will move it into the scheduler once the
// caller side is refactored to consume `release()` directly.

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Redis } from "ioredis";
import { accountGroupMembers, accountGroups, upstreamAccounts } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { Platform } from "@caliber/gateway-core";
import { AccountRuntimeStats } from "./runtimeStats.js";
import {
  getRespSticky,
  setRespSticky,
  getSessionSticky,
  setSessionSticky,
} from "../redis/sticky.js";
import { keys as redisKeys } from "../redis/keys.js";

export type ScheduleLayer =
  | "previous_response_id"
  | "session_hash"
  | "load_balance"
  | "forced";

export interface ScheduleRequest {
  /** Org scope is always required for tenant isolation. */
  orgId: string;
  /** Team scope (if api key was issued under a team). null = org-level only. */
  teamId: string | null;
  /**
   * Group scope. When set, account selection joins
   * account_group_members + filters by group platform. When undefined,
   * the legacy org/team selection is used (Layer 3 only).
   */
  groupId?: string;
  /** Group platform — bound at resolveGroupContext time (Part 8). */
  groupPlatform?: Platform;
  /**
   * BYOK routing policy (Task 9/11). Drives ownership filtering of the
   * candidate query:
   *   - `"pool"`           — org/group pool only; user-owned upstreams are
   *                          NEVER returned (INV1).
   *   - `"own"`            — ONLY the caller's own upstreams
   *                          (`user_id = userId`), groups ignored (INV2).
   *   - `"own_then_pool"`  — own upstreams if any, else fall back to the pool.
   * Defaults to `"pool"` when omitted so every legacy callsite keeps 4A
   * behaviour.
   */
  routingPolicy?: "pool" | "own" | "own_then_pool";
  /**
   * Owning user for `own` / `own_then_pool` selection. Required (non-null)
   * whenever `routingPolicy !== "pool"`; ignored for pool requests.
   */
  userId?: string | null;
  /** Layer 1 sticky key (Codex CLI / OpenAI Responses). */
  previousResponseId?: string;
  /** Layer 2 sticky key (Claude Code / content hash). */
  sessionHash?: string;
  /**
   * Forces a specific account when set; bypasses all 3 layers and
   * surfaces as `layer: "forced"`. Used by callers that already know
   * which account to hit (e.g. probeAccount).
   */
  stickyAccountId?: string;
  /**
   * Trusted eval-pin only — skips the pool/own ownership check in the
   * forced path; all other predicates (org, team/group, schedulable,
   * platform) still enforced. Set ONLY when `evalAccountPin(req)` returned a
   * value (i.e. only for a request authenticated with an eval key), so an
   * external client can never set it. See scheduler.ts's `ownershipOk`
   * re-checks in `loadSchedulableAccount`.
   */
  pinBypassOwnership?: boolean;
  /** Accounts to filter out (failover already tried them). */
  excludedAccountIds?: ReadonlySet<string>;
}

export interface ScheduleDecision {
  layer: ScheduleLayer;
  stickyHit: boolean;
  candidateCount: number;
  selectedAccountId: string;
  selectedAccountType: string;
  /** Platform label for metric slicing (e.g. "anthropic", "openai"). */
  platform: string;
  loadSkew: number;
  latencyMs: number;
}

export interface ScheduledAccount {
  id: string;
  concurrency: number;
  platform: string;
  type: string;
  priority: number;
  groupId: string | null;
}

export interface ScheduleResult {
  account: ScheduledAccount;
  decision: ScheduleDecision;
  release: () => Promise<void>;
}

export interface SchedulerMetrics {
  recordSelect(decision: ScheduleDecision): void;
  recordSwitch(platform: string): void;
  recordLatency(platform: string, ms: number): void;
  recordLoadSkew(platform: string, skew: number): void;
  recordRuntimeAccountCount(count: number): void;
}

export class NoSchedulableAccountsError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly groupId: string | undefined,
    public readonly excludedCount: number,
  ) {
    super(
      `no schedulable accounts in org=${orgId}${groupId ? ` group=${groupId}` : ""} (excluded=${excludedCount})`,
    );
    this.name = "NoSchedulableAccountsError";
  }
}

export interface AccountScheduler {
  select(req: ScheduleRequest): Promise<ScheduleResult>;
  reportResult(
    accountId: string,
    success: boolean,
    firstTokenMs?: number,
  ): void;
  reportSwitch(platform?: string): void;
  snapshotRuntimeStats(): ReturnType<AccountRuntimeStats["snapshot"]>;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_PLATFORM_LABEL = "unknown";

export interface CreateSchedulerOptions {
  db: Database;
  /**
   * Optional Redis client. Sticky layers no-op when omitted (legacy
   * callsites that never carry sticky keys still work).
   */
  redis?: Redis;
  /** Inject for tests so we can seed stats deterministically. */
  stats?: AccountRuntimeStats;
  /** Optional metric sink — `plugins/scheduler.ts` wires the production one. */
  metrics?: SchedulerMetrics;
  /** Top-K candidates to weighted-random over in Layer 3. */
  topK?: number;
  /** Inject for tests. */
  now?: () => number;
  /** Inject for tests so weighted-random is deterministic. */
  random?: () => number;
  /**
   * Logger for sticky-read failures so a flaky Redis can't 500 the
   * request — we fall through to Layer 3 instead. Defaults to silent.
   */
  onStickyError?: (err: unknown, layer: "resp" | "session") => void;
}

export function createScheduler(
  opts: CreateSchedulerOptions,
): AccountScheduler {
  const stats = opts.stats ?? new AccountRuntimeStats();
  const metrics = opts.metrics;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const onStickyError = opts.onStickyError ?? (() => {});

  return {
    async select(req: ScheduleRequest): Promise<ScheduleResult> {
      const t0 = now();
      const result = await runLayers({
        db: opts.db,
        redis: opts.redis,
        stats,
        topK,
        random,
        onStickyError,
        req,
      });
      const latencyMs = now() - t0;
      const decision: ScheduleDecision = {
        ...result.decision,
        latencyMs,
      };
      metrics?.recordSelect(decision);
      metrics?.recordLatency(decision.platform, latencyMs);
      metrics?.recordLoadSkew(decision.platform, decision.loadSkew);
      metrics?.recordRuntimeAccountCount(stats.size());
      return {
        account: result.account,
        decision,
        release: result.release,
      };
    },
    reportResult(accountId, success, firstTokenMs) {
      stats.record(accountId, success, firstTokenMs);
    },
    reportSwitch(platform) {
      metrics?.recordSwitch(platform ?? DEFAULT_PLATFORM_LABEL);
    },
    snapshotRuntimeStats() {
      return stats.snapshot();
    },
  };
}

interface InternalLayerInput {
  db: Database;
  redis?: Redis;
  stats: AccountRuntimeStats;
  topK: number;
  random: () => number;
  onStickyError: (err: unknown, layer: "resp" | "session") => void;
  req: ScheduleRequest;
}

interface InternalLayerResult {
  account: ScheduledAccount;
  decision: Omit<ScheduleDecision, "latencyMs">;
  release: () => Promise<void>;
}

function platformOf(req: ScheduleRequest, account: ScheduledAccount): string {
  return req.groupPlatform ?? account.platform ?? DEFAULT_PLATFORM_LABEL;
}

async function tryRespStickyRead(
  redis: Redis,
  groupId: string,
  previousResponseId: string,
  onErr: (err: unknown, layer: "resp" | "session") => void,
): Promise<string | null> {
  try {
    return await getRespSticky(redis, groupId, previousResponseId);
  } catch (err) {
    onErr(err, "resp");
    return null;
  }
}

async function trySessionStickyRead(
  redis: Redis,
  groupId: string,
  sessionHash: string,
  onErr: (err: unknown, layer: "resp" | "session") => void,
): Promise<string | null> {
  try {
    return await getSessionSticky(redis, groupId, sessionHash);
  } catch (err) {
    onErr(err, "session");
    return null;
  }
}

async function bindStickyKeys(
  redis: Redis | undefined,
  req: ScheduleRequest,
  accountId: string,
): Promise<void> {
  if (!redis || !req.groupId) return;
  if (req.previousResponseId) {
    await setRespSticky(redis, req.groupId, req.previousResponseId, accountId);
  }
  if (req.sessionHash) {
    await setSessionSticky(redis, req.groupId, req.sessionHash, accountId);
  }
}

async function runLayers(
  input: InternalLayerInput,
): Promise<InternalLayerResult> {
  const { db, redis, stats, topK, random, onStickyError, req } = input;
  const excluded = req.excludedAccountIds ?? new Set<string>();

  // Forced override (probeAccount, etc.). Bypasses all 3 layers and is
  // surfaced as its own layer so it doesn't pollute sticky-hit metrics.
  if (req.stickyAccountId && !excluded.has(req.stickyAccountId)) {
    const account = await loadSchedulableAccount(db, req.stickyAccountId, req);
    if (account) {
      return {
        account,
        decision: {
          layer: "forced",
          stickyHit: false,
          candidateCount: 1,
          selectedAccountId: account.id,
          selectedAccountType: account.type,
          platform: platformOf(req, account),
          loadSkew: 0,
        },
        release: noopRelease,
      };
    }
  }

  // Layer 1 — previous_response_id sticky (groupId + redis required)
  if (redis && req.groupId && req.previousResponseId) {
    const cachedAccountId = await tryRespStickyRead(
      redis,
      req.groupId,
      req.previousResponseId,
      onStickyError,
    );
    if (cachedAccountId && !excluded.has(cachedAccountId)) {
      // Sticky layers never bypass ownership — the pin flag applies to the forced path only.
      const account = await loadSchedulableAccount(db, cachedAccountId, {
        ...req,
        groupId: req.groupId,
        pinBypassOwnership: false,
      });
      if (account) {
        // Refresh both keys on hit so a request stream that occasionally
        // drops `previous_response_id` still lands on the same account
        // via Layer 2 next time round.
        await bindStickyKeys(redis, req, account.id);
        return {
          account,
          decision: {
            layer: "previous_response_id",
            stickyHit: true,
            candidateCount: 1,
            selectedAccountId: account.id,
            selectedAccountType: account.type,
            platform: platformOf(req, account),
            loadSkew: 0,
          },
          release: noopRelease,
        };
      }
      // Self-heal: the sticky entry pointed at an account that is now
      // unschedulable or no longer passes ownership re-validation. Delete the
      // stale key so subsequent requests don't repeat the Redis + DB round-trip
      // on every call until the TTL (up to 1h) expires. Best-effort only —
      // a redis error here must never fail the request.
      void redis
        .del(redisKeys.stickyResp(req.groupId, req.previousResponseId))
        .catch(() => {});
    }
  }

  // Layer 2 — session_hash sticky (groupId + redis required)
  if (redis && req.groupId && req.sessionHash) {
    const cachedAccountId = await trySessionStickyRead(
      redis,
      req.groupId,
      req.sessionHash,
      onStickyError,
    );
    if (cachedAccountId && !excluded.has(cachedAccountId)) {
      const account = await loadSchedulableAccount(db, cachedAccountId, {
        ...req,
        groupId: req.groupId,
        pinBypassOwnership: false,
      });
      if (account) {
        await bindStickyKeys(redis, req, account.id);
        return {
          account,
          decision: {
            layer: "session_hash",
            stickyHit: true,
            candidateCount: 1,
            selectedAccountId: account.id,
            selectedAccountType: account.type,
            platform: platformOf(req, account),
            loadSkew: 0,
          },
          release: noopRelease,
        };
      }
      // Self-heal: stale session sticky entry — delete so the next request
      // doesn't hit Redis + DB again until TTL (up to 30m). Best-effort.
      void redis
        .del(redisKeys.stickySession(req.groupId, req.sessionHash))
        .catch(() => {});
    }
  }

  // Layer 3 — load balance
  const candidates = await listSchedulableCandidates(db, req, excluded);
  if (candidates.length === 0) {
    throw new NoSchedulableAccountsError(req.orgId, req.groupId, excluded.size);
  }

  const scored = candidates.map((c) => {
    // Lower DB priority number = higher preference; invert so 1 → 1.0, 100 → 0.01.
    const basePriority = 1 / Math.max(c.priority, 1);
    const weight = stats.weightedScore(c.id, basePriority);
    return { account: c, weight };
  });

  let selectedAccount: CandidateRow;

  if (req.groupId) {
    // Group scope — weighted-random top-K across the group's members so
    // load distributes across roughly-equivalent accounts. EWMA stats are
    // the load signal.
    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, Math.max(1, topK));
    const totalWeight = top.reduce((sum, s) => sum + s.weight, 0);
    selectedAccount = top[0]!.account;
    if (totalWeight > 0) {
      const r = Math.max(0, random()) * totalWeight;
      let acc = 0;
      for (const s of top) {
        acc += s.weight;
        if (r <= acc) {
          selectedAccount = s.account;
          break;
        }
      }
    }
  } else {
    // Legacy org/team scope — preserve 4A's deterministic ladder semantic:
    // team-scoped accounts first, then ORDER BY priority asc, lastUsedAt asc.
    // The candidate list is already sorted; take the head.
    selectedAccount = candidates[0]!;
  }

  await bindStickyKeys(redis, req, selectedAccount.id);

  const loadSkew = computeLoadSkew(scored.map((s) => s.weight));
  const account: ScheduledAccount = {
    id: selectedAccount.id,
    concurrency: selectedAccount.concurrency,
    platform: selectedAccount.platform,
    type: selectedAccount.type,
    priority: selectedAccount.priority,
    groupId: selectedAccount.groupId,
  };

  return {
    account,
    decision: {
      layer: "load_balance",
      stickyHit: false,
      candidateCount: candidates.length,
      selectedAccountId: account.id,
      selectedAccountType: account.type,
      platform: platformOf(req, account),
      loadSkew,
    },
    release: noopRelease,
  };
}

const noopRelease = async () => {};

function computeLoadSkew(weights: readonly number[]): number {
  if (weights.length === 0) return 0;
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  for (const w of weights) {
    if (w > max) max = w;
    if (w < min) min = w;
    sum += w;
  }
  const mean = sum / weights.length;
  if (mean === 0) return 0;
  return (max - min) / mean;
}

interface CandidateRow {
  id: string;
  concurrency: number;
  platform: string;
  type: string;
  priority: number;
  groupId: string | null;
}

/**
 * Predicates shared by `listSchedulableCandidates` + `loadSchedulableAccount`.
 * Encapsulates the "schedulable now" definition (active, not deleted, not
 * rate-limited / overloaded / temp-unschedulable).
 */
function buildSchedulablePredicates(
  nowDate: Date,
  opts: { ignoreRateLimit?: boolean } = {},
): Array<SQL | undefined> {
  const preds: Array<SQL | undefined> = [
    isNull(upstreamAccounts.deletedAt),
    eq(upstreamAccounts.schedulable, true),
    eq(upstreamAccounts.status, "active"),
    or(
      isNull(upstreamAccounts.overloadUntil),
      lt(upstreamAccounts.overloadUntil, nowDate),
    ),
    or(
      isNull(upstreamAccounts.tempUnschedulableUntil),
      lt(upstreamAccounts.tempUnschedulableUntil, nowDate),
    ),
  ];
  // The rate-limit window is dropped for the `probeRateLimitReset` path, which
  // deliberately INCLUDES rate-limited candidates to discover the soonest reset.
  if (!opts.ignoreRateLimit) {
    preds.push(
      or(
        isNull(upstreamAccounts.rateLimitedAt),
        lt(upstreamAccounts.rateLimitResetAt, nowDate),
      ),
    );
  }
  return preds;
}

function teamPredicateFor(teamId: string | null) {
  return teamId
    ? or(
        eq(upstreamAccounts.teamId, teamId),
        isNull(upstreamAccounts.teamId),
      )
    : isNull(upstreamAccounts.teamId);
}

/**
 * Ownership predicate shared by the candidate query (Task 11) and the
 * forced/probe + sticky re-validation paths (Task 12, invariant §1.3.3).
 *
 *   - `pool`               — the resolved account must be a pool row
 *                            (`user_id IS NULL`); a user-owned row is never
 *                            honoured (INV1).
 *   - `own` / `own_then_pool` — accept the caller's own rows
 *                            (`user_id = req.userId`) OR a pool row reached via
 *                            the own_then_pool fallback (`user_id IS NULL`);
 *                            reject any OTHER user's row.
 *
 * `listSchedulableCandidates` enforces these as SQL predicates, but the
 * forced/probe lookup and the Layer 1/2 sticky hits resolve an `accountId`
 * out-of-band (the forced id comes from the caller; a sticky id comes from a
 * Redis entry that may have been written when the account was still pooled —
 * BEFORE it became user-owned). Those paths MUST re-validate the loaded row
 * against this predicate before use so a stale entry can't leak across the
 * pool/own boundary.
 */
function ownershipOk(
  row: { userId: string | null },
  req: ScheduleRequest,
): boolean {
  if (req.routingPolicy === "own" || req.routingPolicy === "own_then_pool") {
    return row.userId === null || row.userId === req.userId;
  }
  return row.userId === null; // pool: never a user-owned row
}

export async function listSchedulableCandidates(
  db: Database,
  req: ScheduleRequest,
  excluded: ReadonlySet<string>,
  opts: { ignoreRateLimit?: boolean } = {},
): Promise<CandidateRow[]> {
  const nowDate = new Date();
  const baseConditions = [
    eq(upstreamAccounts.orgId, req.orgId),
    ...buildSchedulablePredicates(nowDate, opts),
  ];
  if (excluded.size > 0) {
    baseConditions.push(notInArray(upstreamAccounts.id, [...excluded]));
  }
  // Cross-platform isolation. The group branch below is implicitly
  // platform-bound by the account_group_members join; this predicate is
  // load-bearing for the legacy branch (no groupId) where an anthropic-
  // routed request would otherwise pick an OpenAI account and corrupt
  // it with an `invalid x-api-key` we generated ourselves. Applying it
  // to both branches also defends against a group whose members drift
  // from its declared platform.
  if (req.groupPlatform) {
    baseConditions.push(eq(upstreamAccounts.platform, req.groupPlatform));
  }

  // BYOK isolation core (Task 11). INV1: the pool/group AND legacy pool
  // branches must NEVER hand a `pool` request a user-owned upstream, so we
  // append `user_id IS NULL` to both. INV2: `own` / `own_then_pool` first
  // run an own-only query keyed on `user_id = req.userId` and bypass groups
  // entirely.
  const ownershipPool = isNull(upstreamAccounts.userId);
  const policy = req.routingPolicy ?? "pool";

  if (policy === "own" || policy === "own_then_pool") {
    if (!req.userId) {
      // A non-pool policy with no owning user can never match an own-scoped
      // upstream (the XOR constraint guarantees user-owned rows carry a
      // user_id). Returning [] keeps `own` isolated; `own_then_pool` falls
      // through to the pool path below.
      if (policy === "own") return [];
    } else {
      // Own selection ignores groups entirely and mirrors the legacy ordering
      // so failover/load-balance semantics are unchanged for owned upstreams.
      const ownRows = await db
        .select({
          id: upstreamAccounts.id,
          concurrency: upstreamAccounts.concurrency,
          platform: upstreamAccounts.platform,
          type: upstreamAccounts.type,
          priority: upstreamAccounts.priority,
        })
        .from(upstreamAccounts)
        .where(and(eq(upstreamAccounts.userId, req.userId), ...baseConditions))
        .orderBy(
          asc(upstreamAccounts.priority),
          sql`${upstreamAccounts.lastUsedAt} ASC NULLS FIRST`,
        );

      const ownCandidates = ownRows.map((r) => ({
        id: r.id,
        concurrency: r.concurrency,
        platform: r.platform,
        type: r.type,
        priority: r.priority,
        groupId: null,
      }));

      // `own` returns its result even when empty (no pool leak). Only
      // `own_then_pool` falls through to the pool path on an empty own set.
      if (ownCandidates.length > 0 || policy === "own") {
        return ownCandidates;
      }
    }
  }

  if (req.groupId) {
    // Group-based selection: join via account_group_members; the group's
    // priority within the membership row overrides the row-level priority.
    const rows = await db
      .select({
        id: upstreamAccounts.id,
        concurrency: upstreamAccounts.concurrency,
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
        rowPriority: upstreamAccounts.priority,
        groupId: accountGroupMembers.groupId,
        groupPriority: accountGroupMembers.priority,
      })
      .from(upstreamAccounts)
      .innerJoin(
        accountGroupMembers,
        eq(accountGroupMembers.accountId, upstreamAccounts.id),
      )
      .innerJoin(
        accountGroups,
        eq(accountGroups.id, accountGroupMembers.groupId),
      )
      .where(
        and(
          eq(accountGroupMembers.groupId, req.groupId),
          eq(accountGroups.status, "active"),
          isNull(accountGroups.deletedAt),
          // INV1: a pool/group request must never reach a user-owned upstream.
          ownershipPool,
          ...baseConditions,
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      concurrency: r.concurrency,
      platform: r.platform,
      type: r.type,
      // Group-level priority overrides per-account row priority — matches
      // sub2api semantics where groups carry their own priority ladder.
      priority: r.groupPriority ?? r.rowPriority,
      groupId: r.groupId,
    }));
  }

  // Legacy org/team selection (no group). Mirrors selectAccount.ts shape so
  // existing failoverLoop callsites keep their semantics.
  const rows = await db
    .select({
      id: upstreamAccounts.id,
      concurrency: upstreamAccounts.concurrency,
      platform: upstreamAccounts.platform,
      type: upstreamAccounts.type,
      priority: upstreamAccounts.priority,
    })
    .from(upstreamAccounts)
    // INV1 + own_then_pool fallback: the legacy pool path also excludes
    // user-owned upstreams. The own_then_pool fallback lands here (own set was
    // empty), so this is today's null-group legacy branch + `user_id IS NULL`
    // — no anti-join, matching existing behaviour.
    .where(and(teamPredicateFor(req.teamId), ownershipPool, ...baseConditions))
    .orderBy(
      // Mirror selectAccount.ts: team-scoped (teamId IS NOT NULL) before
      // org-level, then priority asc, then NULLS-FIRST lastUsedAt.
      sql`(${upstreamAccounts.teamId} IS NULL) ASC`,
      asc(upstreamAccounts.priority),
      sql`${upstreamAccounts.lastUsedAt} ASC NULLS FIRST`,
    );

  return rows.map((r) => ({
    id: r.id,
    concurrency: r.concurrency,
    platform: r.platform,
    type: r.type,
    priority: r.priority,
    groupId: null,
  }));
}

/**
 * Path-2 rate-limit probe. When `select()` returns NO schedulable candidate,
 * this answers "is that emptiness purely because the candidates are rate-limited
 * right now?" — by re-listing candidates with the rate-limit window IGNORED, then
 * taking the soonest `rate_limit_reset_at` among those currently rate-limited.
 *
 * Returns that reset `Date`, or `null` when there are no candidates at all OR
 * none are currently rate-limited (the emptiness is for some other reason —
 * dead/overloaded/temp-unschedulable). The failover loop turns a non-null
 * result into a transient `RateLimitedError` (→ 429 + Retry-After) instead of
 * the generic `AllUpstreamsFailed` (→ 503). Reuses the SAME ownership / group /
 * platform candidate logic as the normal path so the probe can never surface a
 * row that wasn't actually a candidate for this request.
 */
export async function probeRateLimitReset(
  db: Database,
  req: ScheduleRequest,
  excluded: ReadonlySet<string>,
): Promise<Date | null> {
  const candidates = await listSchedulableCandidates(db, req, excluded, {
    ignoreRateLimit: true,
  });
  if (candidates.length === 0) return null;
  const [row] = await db
    .select({
      soonest: sql<Date | null>`min(${upstreamAccounts.rateLimitResetAt})`,
    })
    .from(upstreamAccounts)
    .where(
      and(
        inArray(
          upstreamAccounts.id,
          candidates.map((c) => c.id),
        ),
        isNotNull(upstreamAccounts.rateLimitedAt),
        gt(upstreamAccounts.rateLimitResetAt, new Date()),
      ),
    );
  // pg returns the MIN() aggregate as a string, not a Date — coerce so callers
  // can call `.getTime()` on it.
  return row?.soonest ? new Date(row.soonest) : null;
}

export async function loadSchedulableAccount(
  db: Database,
  accountId: string,
  req: ScheduleRequest,
): Promise<ScheduledAccount | null> {
  const nowDate = new Date();
  const conditions = [
    eq(upstreamAccounts.id, accountId),
    eq(upstreamAccounts.orgId, req.orgId),
    ...buildSchedulablePredicates(nowDate),
  ];
  // Mirrors listSchedulableCandidates — see comment there.
  if (req.groupPlatform) {
    conditions.push(eq(upstreamAccounts.platform, req.groupPlatform));
  }

  if (req.groupId) {
    // Validate membership in the requested group.
    const rows = await db
      .select({
        id: upstreamAccounts.id,
        concurrency: upstreamAccounts.concurrency,
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
        priority: upstreamAccounts.priority,
        userId: upstreamAccounts.userId,
        groupId: accountGroupMembers.groupId,
      })
      .from(upstreamAccounts)
      .innerJoin(
        accountGroupMembers,
        eq(accountGroupMembers.accountId, upstreamAccounts.id),
      )
      .where(and(eq(accountGroupMembers.groupId, req.groupId), ...conditions))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Re-validate ownership (invariant §1.3.3). Sticky layers are keyed on
    // `groupId`, so they only run for grouped/pool keys (own keys carry no
    // group) — but a sticky row could have been written while this account
    // was still pooled, then the account became user-owned. The forced path
    // likewise names an arbitrary account id. Either could now violate the
    // request's policy, so reject it here and let the caller fall through.
    // `pinBypassOwnership` (trusted eval-pin only, Task 13) skips ONLY this
    // check — org/team/group/schedulable conditions above are unaffected.
    if (!req.pinBypassOwnership && !ownershipOk(row, req)) return null;
    return {
      id: row.id,
      concurrency: row.concurrency,
      platform: row.platform,
      type: row.type,
      priority: row.priority,
      groupId: row.groupId,
    };
  }

  // Legacy single-account lookup must respect teamPredicate so a forced
  // override can't bypass team isolation.
  const rows = await db
    .select({
      id: upstreamAccounts.id,
      concurrency: upstreamAccounts.concurrency,
      platform: upstreamAccounts.platform,
      type: upstreamAccounts.type,
      priority: upstreamAccounts.priority,
      userId: upstreamAccounts.userId,
    })
    .from(upstreamAccounts)
    .where(and(teamPredicateFor(req.teamId), ...conditions))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Re-validate ownership (invariant §1.3.3) — see the group branch above.
  // Guards the forced/probe path (`stickyAccountId`) for legacy/no-group
  // requests against a user-owned account leaking across the pool/own boundary.
  // `pinBypassOwnership` (trusted eval-pin only, Task 13) skips ONLY this
  // check — org/team/schedulable conditions above are unaffected.
  if (!req.pinBypassOwnership && !ownershipOk(row, req)) return null;
  return {
    id: row.id,
    concurrency: row.concurrency,
    platform: row.platform,
    type: row.type,
    priority: row.priority,
    groupId: null,
  };
}

export { AccountRuntimeStats } from "./runtimeStats.js";
