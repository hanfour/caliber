/**
 * GDPR auto-reject stale requests cron (Plan 4B Part 10, Task 10.3).
 *
 * Runs every 24 hours. For each pending (not approved, not rejected) GDPR delete
 * request older than 30 days:
 *   1. Auto-reject with rejectedAt = now() and rejectedReason = "auto-rejected: unresponsive beyond 30 days"
 *   2. Emit gw_gdpr_auto_rejected_total metric
 *
 * Design notes:
 *   - Gate: approvedAt IS NULL AND rejectedAt IS NULL AND requestedAt < now() - '30 days'
 *     ensures we only touch pending requests.
 *   - slaDays and now() are injectable for tests.
 *   - Runs immediately on start, then on 24h interval.
 */

import { and, isNull, lt } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { gdprDeleteRequests } from "@caliber/db";

export const GDPR_EXPIRE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
export const GDPR_SLA_DAYS = 30;

// ── Core function ─────────────────────────────────────────────────────────────

export interface ExpireStaleGdprRequestsInput {
  db: Database;
  /** Override for tests to control "now" without real timers. */
  now?: () => Date;
  /** Override SLA days for tests. Defaults to GDPR_SLA_DAYS (30). */
  slaDays?: number;
}

export interface ExpireStaleGdprRequestsResult {
  autoRejected: number;
}

/**
 * Find pending GDPR requests older than slaDays and auto-reject them.
 *
 * Returns the count of auto-rejected requests. Failures are thrown;
 * the entire operation is a single UPDATE so partial progress is not observable.
 */
export async function expireStaleGdprRequests(
  input: ExpireStaleGdprRequestsInput,
): Promise<ExpireStaleGdprRequestsResult> {
  const { db, now = () => new Date(), slaDays = GDPR_SLA_DAYS } = input;

  // Calculate cutoff: requests requested before this time are stale
  const cutoff = new Date(now().getTime() - slaDays * 24 * 60 * 60 * 1000);

  const result = await db
    .update(gdprDeleteRequests)
    .set({
      rejectedAt: now(),
      rejectedReason: `auto-rejected: unresponsive beyond ${slaDays} days`,
    })
    .where(
      and(
        isNull(gdprDeleteRequests.approvedAt),
        isNull(gdprDeleteRequests.rejectedAt),
        lt(gdprDeleteRequests.requestedAt, cutoff),
      ),
    );

  return {
    autoRejected: (result as { rowCount: number | null }).rowCount ?? 0,
  };
}

// ── Cron ──────────────────────────────────────────────────────────────────────

export interface GdprExpireCronMetrics {
  autoRejectedTotal?: { inc: (n: number) => void };
}

export interface StartGdprExpireCronOptions {
  db: Database;
  metrics?: GdprExpireCronMetrics;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  /** Override interval for tests. Defaults to GDPR_EXPIRE_INTERVAL_MS (24h). */
  intervalMs?: number;
}

export interface GdprExpireCronHandle {
  stop: () => void;
  /** Exposed for tests — awaits the current tick then runs one more. */
  tick: () => Promise<void>;
}

export function startGdprExpireCron(
  opts: StartGdprExpireCronOptions,
): GdprExpireCronHandle {
  const interval = opts.intervalMs ?? GDPR_EXPIRE_INTERVAL_MS;
  let stopped = false;
  let currentTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await expireStaleGdprRequests({ db: opts.db });
      opts.metrics?.autoRejectedTotal?.inc(result.autoRejected);
      if (result.autoRejected > 0) {
        opts.logger.info(result, "gdpr expire cron auto-rejected requests");
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "gdpr expire cron failed",
      );
    }
  }

  // Run immediately on start, then on interval.
  currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, interval);

  // Don't keep process alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: async () => {
      await currentTick;
      await runTick();
    },
  };
}
