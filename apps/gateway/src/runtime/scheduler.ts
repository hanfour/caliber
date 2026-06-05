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

import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
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
      const account = await loadSchedulableAccount(db, cachedAccountId, {
        ...req,
        groupId: req.groupId,
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
function buildSchedulablePredicates(nowDate: Date) {
  return [
    isNull(upstreamAccounts.deletedAt),
    eq(upstreamAccounts.schedulable, true),
    eq(upstreamAccounts.status, "active"),
    or(
      isNull(upstreamAccounts.rateLimitedAt),
      lt(upstreamAccounts.rateLimitResetAt, nowDate),
    ),
    or(
      isNull(upstreamAccounts.overloadUntil),
      lt(upstreamAccounts.overloadUntil, nowDate),
    ),
    or(
      isNull(upstreamAccounts.tempUnschedulableUntil),
      lt(upstreamAccounts.tempUnschedulableUntil, nowDate),
    ),
  ] as const;
}

function teamPredicateFor(teamId: string | null) {
  return teamId
    ? or(
        eq(upstreamAccounts.teamId, teamId),
        isNull(upstreamAccounts.teamId),
      )
    : isNull(upstreamAccounts.teamId);
}

export async function listSchedulableCandidates(
  db: Database,
  req: ScheduleRequest,
  excluded: ReadonlySet<string>,
): Promise<CandidateRow[]> {
  const nowDate = new Date();
  const baseConditions = [
    eq(upstreamAccounts.orgId, req.orgId),
    ...buildSchedulablePredicates(nowDate),
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

async function loadSchedulableAccount(
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
    })
    .from(upstreamAccounts)
    .where(and(teamPredicateFor(req.teamId), ...conditions))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
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
