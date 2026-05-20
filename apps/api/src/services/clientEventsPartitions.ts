import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";

// Monthly partition roll-forward for the `client_events` partitioned parent.
//
// 0013 created partitions for 2026-05 through 2026-08. From 2026-07 onward, a
// daily cron must keep `current_month + N` partitions live so daemon writes
// never fall off the calendar (Postgres rejects INSERTs whose `ingested_at`
// has no matching partition with `no partition of relation ... found`).
//
// Idempotent: every CREATE uses IF NOT EXISTS. Safe to invoke at server boot
// and on a daily timer.

export const PARTITION_ROLL_FORWARD_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_LOOKAHEAD_MONTHS = 3;

interface MonthSpec {
  partitionName: string;
  rangeStart: string; // ISO date string aligned to UTC month start
  rangeEnd: string;
}

function utcMonthStart(year: number, monthIndex0: number): Date {
  return new Date(Date.UTC(year, monthIndex0, 1, 0, 0, 0, 0));
}

function partitionNameForMonth(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `client_events_${year}_${month}`;
}

function monthSpec(d: Date): MonthSpec {
  const start = utcMonthStart(d.getUTCFullYear(), d.getUTCMonth());
  const end = utcMonthStart(d.getUTCFullYear(), d.getUTCMonth() + 1);
  return {
    partitionName: partitionNameForMonth(start),
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
  };
}

// Returns the list of (partition_name, range_start, range_end) for the
// current UTC month + N lookahead months. Exposed for tests.
export function computeUpcomingPartitions(
  now: Date,
  lookaheadMonths: number,
): MonthSpec[] {
  if (lookaheadMonths < 0) {
    throw new Error("lookaheadMonths must be >= 0");
  }
  const out: MonthSpec[] = [];
  for (let i = 0; i <= lookaheadMonths; i += 1) {
    const d = utcMonthStart(now.getUTCFullYear(), now.getUTCMonth() + i);
    out.push(monthSpec(d));
  }
  return out;
}

export interface EnsurePartitionsInput {
  db: Database;
  now?: () => Date;
  lookaheadMonths?: number;
}

export interface EnsurePartitionsResult {
  ensured: string[]; // partition names that were CREATE'd (or already existed)
  created: string[]; // partitions newly created this call
}

// Best-effort create — IF NOT EXISTS guarantees idempotency, but we also probe
// pg_class beforehand so the result can distinguish "newly created" from
// "already existed".
export async function ensureClientEventsPartitions(
  input: EnsurePartitionsInput,
): Promise<EnsurePartitionsResult> {
  const {
    db,
    now = () => new Date(),
    lookaheadMonths = DEFAULT_LOOKAHEAD_MONTHS,
  } = input;

  const upcoming = computeUpcomingPartitions(now(), lookaheadMonths);
  const ensured: string[] = [];
  const created: string[] = [];

  for (const spec of upcoming) {
    const existing = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = ${spec.partitionName}
          AND relkind = 'r'
      ) AS exists
    `);
    const alreadyExists = existing.rows[0]?.exists ?? false;

    // Postgres requires partition bound expressions to be parse-time
    // constants — bound parameters in FOR VALUES are rejected ("bind
    // message supplies N parameters, but prepared statement requires 0").
    // The values here are derived from our own UTC month math (not user
    // input), so inline them with sql.raw safely.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.raw(`"${spec.partitionName}"`)}
      PARTITION OF "client_events"
      FOR VALUES FROM (${sql.raw(`'${spec.rangeStart}'`)})
                  TO  (${sql.raw(`'${spec.rangeEnd}'`)})
    `);
    ensured.push(spec.partitionName);
    if (!alreadyExists) created.push(spec.partitionName);
  }

  return { ensured, created };
}

export interface StartPartitionRollForwardCronOptions {
  db: Database;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  intervalMs?: number;
  lookaheadMonths?: number;
}

export interface PartitionRollForwardCronHandle {
  stop: () => void;
  tick: () => Promise<void>;
}

export function startPartitionRollForwardCron(
  opts: StartPartitionRollForwardCronOptions,
): PartitionRollForwardCronHandle {
  const interval = opts.intervalMs ?? PARTITION_ROLL_FORWARD_INTERVAL_MS;
  const lookahead = opts.lookaheadMonths ?? DEFAULT_LOOKAHEAD_MONTHS;
  let stopped = false;
  let currentTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await ensureClientEventsPartitions({
        db: opts.db,
        lookaheadMonths: lookahead,
      });
      if (result.created.length > 0) {
        opts.logger.info(
          { created: result.created, ensured: result.ensured },
          "client_events partition roll-forward created new partitions",
        );
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "client_events partition roll-forward failed",
      );
    }
  }

  currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, interval);

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
