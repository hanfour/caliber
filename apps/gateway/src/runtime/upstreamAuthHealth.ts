import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { upstreamAccounts, type Database } from "@caliber/db";
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";
import type { Redis } from "ioredis";

const DEGRADE_REASON = "api_key_invalid_credential";
const COUNTER_TTL_SEC = 24 * 60 * 60; // safety reclaim for silent accounts

interface CounterMetric {
  inc(labels: { platform: string }): void;
}
export interface AuthHealthDeps {
  db: Database;
  redis: Redis;
  maxFail: number;
  backoffSec: number;
  graceSec: number;
  metrics: { authFailedTotal: CounterMetric; credentialDegradedTotal: CounterMetric };
  logger: { warn: (obj: unknown, msg: string) => void };
}
export type AuthHealthLoopDeps = Omit<AuthHealthDeps, "db">;
interface AuthAccount {
  id: string;
  type: string;
  platform: string;
}

/**
 * Record an upstream 401 against an api_key account. Best-effort: never throws
 * into the request path. Only a 401 on an api_key account counts; a grace
 * window (just-rotated) short-circuits. On the Nth counted 401 the account is
 * paused recoverably (temp fields only — never `status`, so the scheduler
 * re-admits it when the window lapses). The degraded metric counts only the
 * healthy->degraded DB transition.
 */
export async function recordAuthFailure(
  deps: AuthHealthDeps,
  account: AuthAccount,
  status: number,
): Promise<void> {
  if (status !== 401 || account.type !== "api_key") return;
  try {
    if (await deps.redis.exists(authGraceKey(account.id))) return;
    const key = authFailKey(account.id);
    const n = await deps.redis.incr(key);
    await deps.redis.expire(key, COUNTER_TTL_SEC);
    deps.metrics.authFailedTotal.inc({ platform: account.platform });
    if (n < deps.maxFail) return;
    const until = new Date(Date.now() + deps.backoffSec * 1000);
    const rows = await deps.db
      .update(upstreamAccounts)
      .set({
        tempUnschedulableUntil: until,
        tempUnschedulableReason: DEGRADE_REASON,
        errorMessage: "upstream rejected credential (401)",
      })
      .where(
        and(
          eq(upstreamAccounts.id, account.id),
          or(
            isNull(upstreamAccounts.tempUnschedulableReason),
            ne(upstreamAccounts.tempUnschedulableReason, DEGRADE_REASON),
            isNull(upstreamAccounts.tempUnschedulableUntil),
            lt(upstreamAccounts.tempUnschedulableUntil, new Date()),
          ),
        ),
      )
      .returning({ id: upstreamAccounts.id });
    if (rows.length === 1) {
      deps.metrics.credentialDegradedTotal.inc({ platform: account.platform });
    }
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err, accountId: account.id },
      "upstream auth-health record failed (swallowed)",
    );
  }
}

/** Reset on success: DEL the counter + recover an account degraded for OUR reason. */
export async function clearAuthFailure(
  deps: AuthHealthDeps,
  account: AuthAccount,
): Promise<void> {
  try {
    await deps.redis.del(authFailKey(account.id));
    await deps.db
      .update(upstreamAccounts)
      .set({ tempUnschedulableUntil: null, tempUnschedulableReason: null, errorMessage: null })
      .where(
        and(
          eq(upstreamAccounts.id, account.id),
          eq(upstreamAccounts.tempUnschedulableReason, DEGRADE_REASON),
        ),
      );
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err, accountId: account.id },
      "upstream auth-health clear failed (swallowed)",
    );
  }
}
