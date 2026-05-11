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

import { eq } from "drizzle-orm";
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

export interface RunFailoverInput<T> {
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
  maxSwitches: number;
  attempt: (account: SelectedAccount) => Promise<T>;
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
        excludedAccountIds: failedSet,
      });
    } catch (err) {
      if (err instanceof NoSchedulableAccountsError) {
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
