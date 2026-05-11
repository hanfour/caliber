import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";

export const BODY_PURGE_BATCH_SIZE = 10_000;
export const BODY_PURGE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

export interface PurgeResult {
  deleted: number;
  durationSec: number;
  /** Oldest retention_until vs now(); null if no overdue rows */
  lagHours: number | null;
}

export interface PurgeOptions {
  db: Database;
  /** Override for tests */
  now?: () => Date;
  batchSize?: number;
}

export async function purgeExpiredBodies(
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const {
    db,
    now = () => new Date(),
    batchSize = BODY_PURGE_BATCH_SIZE,
  } = opts;
  const startMs = now().getTime();

  // Step 1 — find oldest overdue row (for lag metric) BEFORE deletion
  const lagRows = await db.execute(sql`
    SELECT MIN(retention_until) as oldest FROM request_bodies
    WHERE retention_until <= ${now()}
  `);
  const oldest = (
    lagRows.rows?.[0] as { oldest: Date | null } | undefined
  )?.oldest;
  const lagHours =
    oldest !== null && oldest !== undefined
      ? (now().getTime() - new Date(oldest).getTime()) / (1000 * 60 * 60)
      : null;

  // Step 2 — loop delete in batches until 0 rows affected
  let totalDeleted = 0;
  // Guard against pathological case where table grows faster than we purge
  const MAX_ITERATIONS = 100;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const deleted = await db.execute(sql`
      DELETE FROM request_bodies
      WHERE request_id IN (
        SELECT request_id FROM request_bodies
        WHERE retention_until <= ${now()}
        LIMIT ${batchSize}
      )
    `);
    const rowCount =
      (deleted as { rowCount: number | null }).rowCount ?? 0;
    totalDeleted += rowCount;
    if (rowCount === 0) break;
  }

  const durationSec = (now().getTime() - startMs) / 1000;
  return { deleted: totalDeleted, durationSec, lagHours };
}

// ── Cron ────────────────────────────────────────────────────────────────────

export interface BodyPurgeCronMetrics {
  deletedTotal: { inc: (n: number) => void };
  durationSeconds: { observe: (v: number) => void };
  lagHours: { set: (v: number) => void };
}

export interface StartBodyPurgeCronOptions {
  db: Database;
  intervalMs?: number;
  metrics: BodyPurgeCronMetrics;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface BodyPurgeCronHandle {
  stop: () => void;
  /** Exposed for tests — awaits the current tick then runs one more */
  tick: () => Promise<void>;
}

export function startBodyPurgeCron(
  opts: StartBodyPurgeCronOptions,
): BodyPurgeCronHandle {
  const intervalMs = opts.intervalMs ?? BODY_PURGE_INTERVAL_MS;
  let stopped = false;
  let currentTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await purgeExpiredBodies({ db: opts.db });
      opts.metrics.deletedTotal.inc(result.deleted);
      opts.metrics.durationSeconds.observe(result.durationSec);
      opts.metrics.lagHours.set(result.lagHours ?? 0);
      opts.logger.info(
        {
          deleted: result.deleted,
          durationSec: result.durationSec,
          lagHours: result.lagHours,
        },
        "body purge cron completed",
      );
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "body purge cron failed",
      );
    }
  }

  // Run immediately on start, then on interval
  currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, intervalMs);

  // Don't keep process alive solely for this timer
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
