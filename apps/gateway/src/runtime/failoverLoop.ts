// Thin wrapper preserved from 4A so existing routes (`messages.ts`,
// `chatCompletions.ts`) keep their signature while the actual selection
// logic lives in the new 3-layer scheduler (Plan 5A Part 7, Task 7.6).
//
// Behaviour preserved:
//   * Same input shape (`db`, `orgId`, `teamId`, `maxSwitches`, `attempt`,
//     optional `sleep`).
//   * Same retry policy: up to MAX_SAME_ACCOUNT_RETRIES on connection /
//     timeout errors (driven by `classifyUpstreamError`), with the same
//     exponential-ish backoff supplied by the classifier.
//   * Same DB state mutation on switch: rateLimitedAt / overloadUntil /
//     tempUnschedulableUntil / status changes mirror 4A.
//   * Same exceptions: `AllUpstreamsFailed`, `FatalUpstreamError`.
//
// What's new: the candidate-selection step now goes through
// `scheduler.select()`. For these legacy callsites no group / sticky
// metadata is supplied so the scheduler short-circuits to Layer 3
// (load_balance), which still uses the org/team scope. EWMA stats are
// fed via `reportResult` after each attempt so subsequent decisions
// benefit from observed reliability.

import { and, eq, isNull } from "drizzle-orm";
import { upstreamAccounts } from "@caliber/db";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import {
  classifyUpstreamError,
  type AccountStateUpdate,
  type Platform,
  type UpstreamError,
} from "@caliber/gateway-core";
import {
  createScheduler,
  NoSchedulableAccountsError,
  type AccountScheduler,
  type SchedulerMetrics,
} from "./scheduler.js";
import type { SelectedAccount } from "./selectAccount.js";
import {
  clearAuthFailure,
  recordAuthFailure,
  type AuthHealthLoopDeps,
} from "./upstreamAuthHealth.js";

const MAX_SAME_ACCOUNT_RETRIES = 3;

export class AllUpstreamsFailed extends Error {
  constructor(public readonly attemptedIds: string[]) {
    super(`All upstreams failed after ${attemptedIds.length} attempts`);
    this.name = "AllUpstreamsFailed";
  }
}

export class FatalUpstreamError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    public readonly cause?: Error,
  ) {
    super(`fatal upstream: ${reason} (${statusCode})`);
    this.name = "FatalUpstreamError";
  }
}

/**
 * BYOK §4.1 existence-vs-schedulability split. Thrown by `runFailover` ONLY
 * when `routingPolicy === "own"` AND the scheduler found no schedulable
 * candidate AND a SEPARATE unfiltered existence check found NO non-deleted
 * own upstream for the request's platform — i.e. the user has not registered
 * any credential for this surface at all.
 *
 * Route handlers MUST map this to a CLEAN 409 `no_own_upstream` (NOT 503, and
 * NOT a bare re-throw — the gateway has no setErrorHandler so an unmapped
 * throw defaults to 500). It is distinct from `AllUpstreamsFailed`, which
 * still covers the "own upstream exists but is currently unschedulable"
 * (paused / rate-limited / overloaded / not active) transient case.
 */
export class NoOwnUpstreamError extends Error {
  constructor(public readonly platform: Platform) {
    super(`no own upstream registered for platform=${platform}`);
    this.name = "NoOwnUpstreamError";
  }
}

export interface RunFailoverInput<T> {
  // ⚠️ BYOK ISOLATION CONTRACT (Task 9/11) — EVERY ROUTE-HANDLER CALLER
  // MUST supply `routingPolicy` AND `userId`. They are now REQUIRED (no
  // `?? "pool"` / `?? null` defaults below): omitting either at a route
  // callsite is a COMPILE error, not a silent own→pool isolation downgrade
  // (a BYOK "own" key routing as `pool` leaks the org pool to a user-scoped
  // key). Route handlers MUST NOT build this object by hand — they go through
  // `buildFailoverInput(req, db, { ...perCall })`, which reads
  // `req.gwGroupContext` + `req.apiKey` and populates BOTH fields, so the
  // per-call object physically cannot omit them. The loop's own
  // unit/integration tests (no inbound api-key) pass `routingPolicy: "pool",
  // userId: null` explicitly to preserve 4A mechanics.
  db: Database;
  orgId: string;
  teamId: string | null;
  /**
   * Platform of the inbound api-key's resolved group context. Required:
   * the scheduler uses it to filter the legacy candidate query so an
   * anthropic-routed request can't pick an OpenAI account (and vice
   * versa). Legacy api-keys without `group_id` get a synthetic
   * `"anthropic"` from groupContext, preserving 4A behaviour while
   * still preventing the cross-platform leak.
   */
  platform: Platform;
  /**
   * AccountGroup the inbound api-key is bound to. When set, scheduler
   * `select` joins via `account_group_members` and filters to the
   * group's platform. `null` is a real value (legacy api-keys without
   * `group_id` opt into org-wide selection); platform isolation is
   * enforced via the `platform` field above either way.
   */
  groupId?: string | null;
  /**
   * BYOK routing policy of the inbound api-key (Task 9/11). Forwarded to
   * `scheduler.select` so the candidate query can scope to the caller's own
   * upstreams. REQUIRED — `buildFailoverInput` sets it from
   * `req.gwGroupContext.policy`; loop-mechanics tests pass `"pool"`.
   */
  routingPolicy: "pool" | "own" | "own_then_pool";
  /**
   * Owning user of the inbound api-key. REQUIRED (non-null) when
   * `routingPolicy !== "pool"` so the scheduler can filter
   * `user_id = userId`; ignored for pool keys but still REQUIRED on the type
   * so omission is a compile error. `buildFailoverInput` sets it from
   * `req.apiKey.userId`; loop-mechanics tests pass `null`.
   */
  userId: string | null;
  maxSwitches: number;
  attempt: (account: SelectedAccount) => Promise<T>;
  /**
   * Layer 1 sticky key (Plan 5A §8.2) — `previous_response_id` from the
   * OpenAI Responses surface (Codex). Forwarded to `scheduler.select`; the
   * scheduler reads/binds `sticky:resp:{groupId}:*`. Only takes effect when
   * `groupId` is set and a Redis client is available.
   */
  previousResponseId?: string;
  /**
   * Layer 2 sticky key (Plan 5A §8.2) — a hash of the Claude Code session
   * identifier (`X-Claude-Session-Id`). Forwarded to `scheduler.select`;
   * the scheduler reads/binds `sticky:session:{groupId}:*`.
   */
  sessionHash?: string;
  /** Inject for tests so we can fast-forward backoffs. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional Redis client. Not used by the legacy path (no sticky
   * metadata is supplied here) but reserved so future callsites that
   * pass `groupId` / `previousResponseId` can opt in.
   */
  redis?: Redis;
  /**
   * Optional pre-built scheduler. When omitted a fresh one is created
   * each call — fine for low-frequency unit tests, the production
   * gateway will inject a long-lived instance via fastify decoration.
   */
  scheduler?: AccountScheduler;
  /** Metric sink — only consumed when an internal scheduler is created. */
  metrics?: SchedulerMetrics;
  /**
   * api_key credential-health deps (redis/config/metrics/logger), assembled
   * by buildFailoverInput from req.server. Absent in unit tests that build the
   * input by hand → the loop's auth-health hooks no-op.
   */
  authHealth?: AuthHealthLoopDeps;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function runFailover<T>(input: RunFailoverInput<T>): Promise<T> {
  const sleep = input.sleep ?? defaultSleep;
  const failed: string[] = [];
  const failedSet = new Set<string>();
  const scheduler =
    input.scheduler ??
    createScheduler({
      db: input.db,
      redis: input.redis,
      metrics: input.metrics,
    });

  for (let switchCount = 0; switchCount < input.maxSwitches; switchCount++) {
    let scheduled;
    try {
      scheduled = await scheduler.select({
        orgId: input.orgId,
        teamId: input.teamId,
        groupPlatform: input.platform,
        groupId: input.groupId ?? undefined,
        routingPolicy: input.routingPolicy,
        userId: input.userId,
        previousResponseId: input.previousResponseId,
        sessionHash: input.sessionHash,
        excludedAccountIds: failedSet,
      });
    } catch (err) {
      if (err instanceof NoSchedulableAccountsError) {
        // BYOK §4.1 existence-vs-schedulability split. For a bare `own`
        // key, an empty FILTERED candidate set is ambiguous: the user may
        // have registered no credential at all for this platform, OR they
        // have one that is simply unschedulable right now. Distinguish with
        // a SEPARATE UNFILTERED existence check (any non-deleted own row for
        // the platform, IGNORING schedulable/status/rate-limit filters).
        // `own_then_pool` and `pool` are unaffected — they keep the existing
        // transient AllUpstreamsFailed semantics.
        if (input.routingPolicy === "own" && input.userId) {
          const [ownRow] = await input.db
            .select({ id: upstreamAccounts.id })
            .from(upstreamAccounts)
            .where(
              and(
                eq(upstreamAccounts.userId, input.userId),
                eq(upstreamAccounts.platform, input.platform),
                isNull(upstreamAccounts.deletedAt),
              ),
            )
            .limit(1);
          if (!ownRow) {
            // No credential registered at all → clean 409 (route handlers
            // map NoOwnUpstreamError → 409 no_own_upstream). NOT 503.
            throw new NoOwnUpstreamError(input.platform);
          }
          // else: an own upstream exists but is unschedulable → fall through
          // to the existing transient/503 no-schedulable path below.
        }
        throw new AllUpstreamsFailed(failed);
      }
      throw err;
    }

    const { account, release } = scheduled;
    let exhaustedSameAccount = false;

    // Common bookkeeping for "give up on this account": record the EWMA
    // failure, log the switch, push the id onto the failed list, free
    // the slot. Used by switch_account, exhausted-retries, and fatal.
    const giveUp = async (markSwitch: boolean): Promise<void> => {
      scheduler.reportResult(account.id, false);
      if (markSwitch) {
        scheduler.reportSwitch(account.platform);
        failed.push(account.id);
        failedSet.add(account.id);
      }
      await release();
    };

    for (let retry = 0; retry <= MAX_SAME_ACCOUNT_RETRIES; retry++) {
      try {
        const result = await input.attempt({
          id: account.id,
          concurrency: account.concurrency,
        });
        scheduler.reportResult(account.id, true);
        // Centralized api_key credential-health clear: a successful attempt
        // return is the SINGLE 2xx choke point (streaming attempts also return
        // normally on completion), so this covers stream + non-stream. Resets
        // the 401 counter and recovers an account we degraded for our reason.
        if (input.authHealth) {
          await clearAuthFailure(
            { ...input.authHealth, db: input.db },
            { id: account.id, type: account.type, platform: account.platform },
          );
        }
        await release();
        return result;
      } catch (rawErr) {
        const upstreamErr = toUpstreamError(rawErr);
        const action = classifyUpstreamError(upstreamErr);

        if (action.kind === "fatal") {
          if (action.stateUpdate) {
            await applyAccountStateUpdate(
              input.db,
              account.id,
              action.stateUpdate,
            );
          }
          await giveUp(false);
          // Preserve the upstream body / message on the cause so route
          // catches can surface it to the client. The classifier strips
          // it down to a generic `reason` label (e.g. "client_error"),
          // which obscures actionable detail like anthropic's
          // `invalid_request_error: stream is required for ...`.
          const cause =
            rawErr instanceof Error
              ? rawErr
              : (() => {
                  const m = (rawErr as { message?: unknown })?.message;
                  return new Error(
                    typeof m === "string" ? m : String(rawErr),
                  );
                })();
          throw new FatalUpstreamError(
            action.statusCode,
            action.reason,
            cause,
          );
        }

        if (action.kind === "retry_same_account") {
          if (retry === MAX_SAME_ACCOUNT_RETRIES) {
            exhaustedSameAccount = true;
            break;
          }
          await sleep(action.backoffMs);
          continue;
        }

        // switch_account
        if (action.stateUpdate) {
          await applyAccountStateUpdate(
            input.db,
            account.id,
            action.stateUpdate,
          );
        }
        // Centralized api_key credential-health record: only the classifier's
        // `auth_invalid` (401/403) counts (recordAuthFailure further gates to
        // type === "api_key" + status === 401). Threshold-degrades the account
        // recoverably; failover still proceeds via giveUp below.
        if (action.reason === "auth_invalid" && input.authHealth) {
          await recordAuthFailure(
            { ...input.authHealth, db: input.db },
            { id: account.id, type: account.type, platform: account.platform },
            "status" in upstreamErr ? upstreamErr.status : 0,
          );
        }
        await giveUp(true);
        break;
      }
    }

    if (exhaustedSameAccount) {
      // 3 retries on connection/timeout exhausted — try a different account.
      await giveUp(true);
    }
  }

  throw new AllUpstreamsFailed(failed);
}

export async function applyAccountStateUpdate(
  db: Database,
  accountId: string,
  update: AccountStateUpdate,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (update.rateLimitedAt !== undefined)
    set.rateLimitedAt = update.rateLimitedAt;
  if (update.rateLimitResetAt !== undefined)
    set.rateLimitResetAt = update.rateLimitResetAt;
  if (update.overloadUntil !== undefined)
    set.overloadUntil = update.overloadUntil;
  if (update.tempUnschedulableUntil !== undefined)
    set.tempUnschedulableUntil = update.tempUnschedulableUntil;
  if (update.tempUnschedulableReason !== undefined)
    set.tempUnschedulableReason = update.tempUnschedulableReason;
  if (update.status !== undefined) set.status = update.status;
  if (update.errorMessage !== undefined) set.errorMessage = update.errorMessage;
  if (Object.keys(set).length === 0) return;
  set.updatedAt = new Date();
  await db
    .update(upstreamAccounts)
    .set(set)
    .where(eq(upstreamAccounts.id, accountId));
}

/** Coerces a thrown value into the discriminated UpstreamError shape. */
function toUpstreamError(rawErr: unknown): UpstreamError {
  if (rawErr && typeof rawErr === "object") {
    const e = rawErr as Record<string, unknown>;
    if (typeof e.status === "number") {
      return {
        status: e.status,
        retryAfter: typeof e.retryAfter === "number" ? e.retryAfter : undefined,
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
    if (
      e.code === "ETIMEDOUT" ||
      e.code === "UND_ERR_HEADERS_TIMEOUT" ||
      e.code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return {
        kind: "timeout",
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
    if (
      e.code === "ECONNREFUSED" ||
      e.code === "ECONNRESET" ||
      e.code === "EPIPE" ||
      e.code === "UND_ERR_SOCKET" ||
      e.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return {
        kind: "connection",
        message: typeof e.message === "string" ? e.message : undefined,
      };
    }
  }
  // Last resort: synthetic 500
  return {
    status: 500,
    message: rawErr instanceof Error ? rawErr.message : String(rawErr),
  };
}
