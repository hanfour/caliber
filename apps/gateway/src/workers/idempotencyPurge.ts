import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";

export const IDEMPOTENCY_PURGE_BATCH_SIZE = 10_000;
export const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1h

export interface IdempotencyPurgeResult {
  deleted: number;
  durationSec: number;
}

export interface IdempotencyPurgeOptions {
  db: Database;
  now?: () => Date;
  batchSize?: number;
}

export async function purgeExpiredIdempotencyRecords(
  opts: IdempotencyPurgeOptions,
): Promise<IdempotencyPurgeResult> {
  const {
    db,
    now = () => new Date(),
    batchSize = IDEMPOTENCY_PURGE_BATCH_SIZE,
  } = opts;
  const cutoff = now();
  const startMs = cutoff.getTime();

  let totalDeleted = 0;
  const MAX_ITERATIONS = 100;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const deleted = await db.execute(sql`
      DELETE FROM idempotency_records r
      USING (
        SELECT api_key_id, request_id FROM idempotency_records
        WHERE expires_at <= ${cutoff}
        LIMIT ${batchSize}
      ) doomed
      WHERE r.api_key_id = doomed.api_key_id
        AND r.request_id = doomed.request_id
        AND r.expires_at <= ${cutoff}
    `);
    const rowCount = (deleted as { rowCount: number | null }).rowCount ?? 0;
    totalDeleted += rowCount;
    if (rowCount === 0) break;
  }

  return {
    deleted: totalDeleted,
    durationSec: (Date.now() - startMs) / 1000,
  };
}

export interface IdempotencyPurgeCronHandle {
  stop: () => void;
}

export function startIdempotencyPurgeCron(deps: {
  db: Database;
  metrics: { purgedTotal: { inc: (n?: number) => void } };
  logger: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
  };
  intervalMs?: number;
}): IdempotencyPurgeCronHandle {
  const intervalMs = deps.intervalMs ?? IDEMPOTENCY_PURGE_INTERVAL_MS;
  const timer = setInterval(() => {
    void purgeExpiredIdempotencyRecords({ db: deps.db })
      .then((r) => {
        if (r.deleted > 0) deps.metrics.purgedTotal.inc(r.deleted);
        deps.logger.info(
          { deleted: r.deleted, durationSec: r.durationSec },
          "idempotency_records purge tick",
        );
      })
      .catch((err) =>
        deps.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "idempotency_records purge failed",
        ),
      );
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
