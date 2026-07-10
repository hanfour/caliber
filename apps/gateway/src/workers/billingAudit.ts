/**
 * Hourly billing sanity audit (Plan 4A Part 7, Task 7.4).
 *
 * Samples a small fraction of `api_keys` (default 1% via Postgres
 * BERNOULLI sampling) and compares each key's `quota_used_usd` against
 * `SUM(usage_logs.actual_cost_usd)` for that key.  Two integrity signals are
 * surfaced:
 *
 *   1. **Drift** — `|sum(actual_cost_usd) - quota_used_usd| > 0.01 USD`.
 *      Either direction; bumps `gw_billing_drift_total`.
 *
 *   2. **Monotonicity violation** — `quota_used_usd > sum(actual_cost_usd) +
 *      0.01 USD`.  Means quota was charged for a row that no longer
 *      exists in `usage_logs` (deleted? failed insert mid-txn?).
 *      Bumps `gw_billing_monotonicity_violation_total`.  A monotonicity
 *      violation is also drift by definition, so both counters move.
 *
 * Both counters are zero-valued in steady state.  Drift detection logs
 * the offending `apiKeyId` plus expected/actual/drift values so an
 * operator can reconcile by hand.  Sampling keeps the audit cheap on
 * very large tenants — at 1% Bernoulli a 1M-row table averages 10k
 * scanned rows per tick, easily inside the hourly budget.
 *
 * Decimal arithmetic happens entirely in Postgres (`numeric`) — pulling
 * `decimal(20,8)` rows into JS would lose precision.  The cron compares
 * via SQL booleans and only formats the offending values as strings for
 * logging.
 *
 * Cron lifecycle: per-instance `start()` arms a jittered first run, each
 * tick re-arms with `intervalMs` (default 1h), `runOnce()` is exposed
 * for tests so the timer is not in the loop.
 */

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@caliber/db";

// ── Defaults ─────────────────────────────────────────────────────────────────

/** One hour between runs in production. */
const DEFAULT_INTERVAL_MS = 3_600_000;

/** Random delay before the first tick; spreads multi-instance load. */
const DEFAULT_JITTER_MAX_MS = 30_000;

/** 1% Bernoulli sample. */
const DEFAULT_SAMPLE_RATIO = 1;

/** Drift larger than 1¢ counts as drift. */
const DEFAULT_DRIFT_THRESHOLD_USD = 0.01;

/** Bounds applied to opts.sampleRatio. Bernoulli accepts (0, 100]; we
 *  forbid 0 (would always sample 0 rows) and clamp the lower bound to a
 *  number we can reasonably express as a Postgres percentage literal. */
const MIN_SAMPLE_RATIO = 0.1;
const MAX_SAMPLE_RATIO = 100;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Pino-style logger surface used by the audit, structurally compatible
 * with `fastify.log` so we can pass it directly.
 */
export interface BillingAuditLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Subset of `prom-client.Counter` we touch.  Concrete counters live in
 * `plugins/metrics.ts`; tests inject any object that satisfies this shape.
 */
export interface CounterLike {
  inc(n?: number): void;
}

export interface BillingAuditMetrics {
  /** Bumped once per drifted api_key. */
  billingDriftTotal?: CounterLike;
  /** Bumped once per monotonicity violation (subset of drift). */
  billingMonotonicityViolationTotal?: CounterLike;
}

export interface BillingAuditOptions {
  logger: BillingAuditLogger;
  /** Optional metric counters. */
  metrics?: BillingAuditMetrics;
  /** Override module default (1h). */
  intervalMs?: number;
  /** Bernoulli sample percentage. Range [0.1, 100]. Default 1. */
  sampleRatio?: number;
  /** Override module default ($0.01). */
  driftThresholdUsd?: number;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests; controls the initial jitter delay. */
  jitter?: () => number;
}

export interface BillingAuditResult {
  /** Number of api_keys the BERNOULLI sample picked up. */
  sampled: number;
  /** Subset of `sampled` whose |drift| exceeded the threshold. */
  drifted: number;
  /** Subset of `drifted` where actual < expected. */
  monotonicityViolations: number;
}

// ── Worker ───────────────────────────────────────────────────────────────────

/**
 * Samples ALL api_keys (active + revoked). Revoked keys don't accumulate
 * new charges, so their drift signal is stable post-revocation — but it
 * MUST remain visible in the audit so an admin cannot silently hide a
 * drifted key by revoking it. Drift found on a revoked key implies a prior
 * billing-integrity issue and should be reconciled manually.
 */
export class BillingAudit {
  readonly #db: Database;
  readonly #logger: BillingAuditLogger;
  readonly #metrics: BillingAuditMetrics;
  readonly #intervalMs: number;
  readonly #sampleRatio: number;
  readonly #sampleRatioLiteral: SQL;
  readonly #driftThresholdUsd: number;
  readonly #jitter: () => number;
  #handle: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, opts: BillingAuditOptions) {
    this.#db = db;
    this.#logger = opts.logger;
    this.#metrics = opts.metrics ?? {};
    this.#intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#sampleRatio = clampSampleRatio(
      opts.sampleRatio ?? DEFAULT_SAMPLE_RATIO,
    );
    // Postgres needs the BERNOULLI percentage as a literal; we've already
    // validated `sampleRatio` to a sane numeric range above, so wrapping it
    // with sql.raw() here is safe.  Building the literal in the constructor
    // (rather than in runOnce) makes it visually unambiguous that the value
    // passed to sql.raw is the validated private field, not user input that
    // could leak through a future refactor.
    this.#sampleRatioLiteral = sql.raw(this.#sampleRatio.toString());
    this.#driftThresholdUsd =
      opts.driftThresholdUsd ?? DEFAULT_DRIFT_THRESHOLD_USD;
    this.#jitter = opts.jitter ?? defaultJitter;
  }

  /**
   * Start the audit cron with per-instance jitter (0..30s).  Idempotent —
   * calling start() twice does not double-schedule.
   */
  start(): void {
    if (this.#handle !== null) return;
    const jitterMs = this.#jitter();
    this.#handle = setTimeout(() => {
      void this.#tickAndSchedule();
    }, jitterMs);
  }

  /** Stop the audit cron.  Idempotent — safe on never-started instances. */
  stop(): void {
    if (this.#handle !== null) {
      clearTimeout(this.#handle);
      this.#handle = null;
    }
  }

  /**
   * Run a single audit pass — samples api_keys, computes drift in SQL,
   * iterates results, logs + bumps counters.  Exposed for direct use in
   * tests (no timer needed).
   *
   * Returns `{ sampled, drifted, monotonicityViolations }` for assertions
   * and structured logs.
   */
  async runOnce(): Promise<BillingAuditResult> {
    const threshold = this.#driftThresholdUsd;
    // Stamp every per-key event from this tick (and the summary) with the
    // same ISO timestamp so forensics can link individual drift/violation
    // entries back to their summary line.
    const auditRunAt = new Date().toISOString();

    const rows = await this.#db.execute<{
      api_key_id: string;
      expected: string;
      actual: string;
      drifted: boolean;
      monotonicity_violation: boolean;
    }>(sql`
      WITH sampled AS (
        SELECT
          ak.id,
          ak.quota_used_usd,
          COALESCE(
            (SELECT SUM(actual_cost_usd) FROM usage_logs WHERE api_key_id = ak.id),
            0
          ) AS actual_sum
        FROM api_keys ak TABLESAMPLE BERNOULLI(${this.#sampleRatioLiteral})
      )
      SELECT
        id::text AS api_key_id,
        quota_used_usd::text AS expected,
        actual_sum::text AS actual,
        (ABS(actual_sum - quota_used_usd) > ${threshold}::numeric) AS drifted,
        (quota_used_usd - actual_sum > ${threshold}::numeric) AS monotonicity_violation
      FROM sampled
    `);

    let drifted = 0;
    let monotonicityViolations = 0;

    for (const row of rows.rows) {
      if (!row.drifted) continue;
      drifted++;
      this.#metrics.billingDriftTotal?.inc(1);
      this.#logger.warn(
        {
          type: "gw_billing_drift",
          auditRunAt,
          apiKeyId: row.api_key_id,
          expected: row.expected,
          actual: row.actual,
        },
        "billing audit: drift detected",
      );

      if (row.monotonicity_violation) {
        monotonicityViolations++;
        this.#metrics.billingMonotonicityViolationTotal?.inc(1);
        this.#logger.error(
          {
            type: "gw_billing_monotonicity_violation",
            auditRunAt,
            apiKeyId: row.api_key_id,
            expected: row.expected,
            actual: row.actual,
          },
          "billing audit: monotonicity violation",
        );
      }
    }

    const result: BillingAuditResult = {
      sampled: rows.rows.length,
      drifted,
      monotonicityViolations,
    };

    this.#logger.info(
      {
        auditRunAt,
        sampled: result.sampled,
        drifted: result.drifted,
        monotonicityViolations: result.monotonicityViolations,
        sampleRatio: this.#sampleRatio,
      },
      "billing audit: tick complete",
    );

    return result;
  }

  async #tickAndSchedule(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.#logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "billing audit: tick failed",
      );
    }
    // Re-arm only if stop() wasn't called in the meantime.  Without this
    // guard a stop() during a long runOnce() would leak the next timer.
    if (this.#handle !== null) {
      this.#handle = setTimeout(() => {
        void this.#tickAndSchedule();
      }, this.#intervalMs);
    }
  }
}

function clampSampleRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    throw new Error(
      `BillingAudit: sampleRatio must be finite, got ${String(ratio)}`,
    );
  }
  if (ratio < MIN_SAMPLE_RATIO || ratio > MAX_SAMPLE_RATIO) {
    throw new Error(
      `BillingAudit: sampleRatio ${ratio} outside [${MIN_SAMPLE_RATIO}, ${MAX_SAMPLE_RATIO}]`,
    );
  }
  return ratio;
}

function defaultJitter(): number {
  return Math.floor(Math.random() * DEFAULT_JITTER_MAX_MS);
}
