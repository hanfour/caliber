/**
 * BullMQ queue + thin wrapper for usage log writes (Plan 4A Part 7, Task 7.1).
 *
 * Design notes:
 *   - The plan/design doc names the queue "aide:gw:usage-log".  BullMQ namespaces
 *     keys as `<prefix>:<name>:*`, so we set prefix="aide:gw" + name="usage-log",
 *     which yields the expected `aide:gw:usage-log:*` Redis keyspace.
 *
 *   - We do NOT pass the gateway's existing `keyPrefix`-laden ioredis client to
 *     BullMQ. BullMQ's Lua scripts compute keys themselves and break when the
 *     underlying ioredis transparently re-prefixes. Pass a fresh connection
 *     (RedisOptions or a dedicated Redis instance) when constructing the Queue.
 *
 *   - The job payload carries pre-computed cost decimals as strings. The route
 *     handler already has tokens + model + multipliers; computing cost there
 *     keeps pricing close to the request and lets the future worker (Task 7.2)
 *     stay a pure batched DB writer (insert + quota update). Decimals are passed
 *     as strings so they survive JSON round-trip without float drift.
 *
 *   - This module exports a `QueueLike` interface so unit tests can inject a
 *     fake. End-to-end queue behaviour (Lua scripts, deduplication via Redis)
 *     is exercised in the worker integration test (Task 7.2).
 */

import { Queue, type JobsOptions, type RedisOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Database } from "@caliber/db";
import { writeUsageLogBatch } from "./writeUsageLogBatch.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const USAGE_LOG_QUEUE_NAME = "usage-log";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `aide:gw:usage-log:*`, matching the design-doc identifier
 * "aide:gw:usage-log".
 */
export const USAGE_LOG_QUEUE_PREFIX = "aide:gw";

/** BullMQ job name used for every usage-log write. */
export const USAGE_LOG_JOB_NAME = "usage-log";

/** Default retry / retention policy for usage-log jobs. */
export const USAGE_LOG_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
} as const satisfies JobsOptions;

// ── Payload schema ───────────────────────────────────────────────────────────

const UUID = z.string().uuid();

/**
 * Decimal-string for cost columns. usage_logs cost columns are
 * `decimal(20, 10)` — Postgres rejects non-numeric strings, so validate format
 * before enqueue. Allows optional leading minus (refunds / corrections), an
 * integer part, and optional fractional part.
 */
const DECIMAL_STRING = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal-formatted string");

const NON_NEGATIVE_INT = z.number().int().nonnegative();
const STATUS_CODE = z.number().int().min(100).max(599);

/**
 * Job payload validated at enqueue time. Mirrors the columns of usage_logs the
 * worker needs to insert + the api_keys.quota_used_usd update.
 */
export const UsageLogJobPayload = z.object({
  // Identity / scope
  requestId: z.string().min(1),
  userId: UUID,
  apiKeyId: UUID,
  accountId: UUID,
  orgId: UUID,
  teamId: UUID.nullable(),

  // Request shape
  requestedModel: z.string().min(1),
  upstreamModel: z.string().min(1),
  platform: z.string().min(1),
  surface: z.string().min(1),
  stream: z.boolean(),

  // Token counts
  inputTokens: NON_NEGATIVE_INT,
  outputTokens: NON_NEGATIVE_INT,
  cacheCreationTokens: NON_NEGATIVE_INT,
  cacheReadTokens: NON_NEGATIVE_INT,
  // Plan 5A — Anthropic prompt-cache TTL split.  Sums to cacheCreationTokens
  // when the upstream response exposes the breakdown; otherwise 0.  Callers
  // (buildUsageLogPayload) always supply explicit values — no zod default
  // here so the payload type is unambiguous at insertion sites.
  cacheCreation5mTokens: NON_NEGATIVE_INT,
  cacheCreation1hTokens: NON_NEGATIVE_INT,
  // Plan 5A — OpenAI cached_input.  Always 0 for Anthropic rows.
  cachedInputTokens: NON_NEGATIVE_INT,

  // Pre-computed cost decimals (worker just inserts these verbatim)
  inputCost: DECIMAL_STRING,
  outputCost: DECIMAL_STRING,
  cacheCreationCost: DECIMAL_STRING,
  cacheReadCost: DECIMAL_STRING,
  // Plan 5A — OpenAI cached_input cost; tracked separately from inputCost so
  // dashboards can attribute the discount.  Always "0" for Anthropic rows.
  cachedInputCost: DECIMAL_STRING,
  totalCost: DECIMAL_STRING,
  // Plan 5A — second-stage billing per design §11.3 / X8.
  // = totalCost × rateMultiplier × accountRateMultiplier.  Computed at
  // payload-build time so the worker writes a verbatim ledger value.
  actualCostUsd: DECIMAL_STRING,

  // Pricing multipliers in effect at request time (audit trail)
  rateMultiplier: DECIMAL_STRING,
  accountRateMultiplier: DECIMAL_STRING,

  // Plan 5A — group routing trail.  NULL on legacy rows or when the api-key
  // is not yet bound to a group.
  groupId: UUID.nullable(),

  // Outcome / timing
  statusCode: STATUS_CODE,
  durationMs: NON_NEGATIVE_INT,
  firstTokenMs: NON_NEGATIVE_INT.nullable(),
  bufferReleasedAtMs: NON_NEGATIVE_INT.nullable(),
  upstreamRetries: NON_NEGATIVE_INT,
  failedAccountIds: z.array(UUID),

  // Client metadata (nullable — depends on trust-proxy chain + UA presence)
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
});

export type UsageLogJobPayload = z.infer<typeof UsageLogJobPayload>;

// ── Queue interface (for DI in tests) ────────────────────────────────────────

/**
 * Subset of BullMQ's Queue API that this module depends on. Exposed so unit
 * tests can swap in a fake without standing up a real Redis-backed queue.
 *
 * Note: `add` returns `Promise<unknown>` because the wrapper does not consume
 * the return value — `enqueueUsageLog` derives `jobId` from the validated
 * payload itself and returns that to the caller. The real BullMQ `Queue.add`
 * resolves to a `Job` instance; tests may return any stand-in.
 */
export interface QueueLike {
  add(
    name: string,
    data: UsageLogJobPayload,
    opts?: JobsOptions,
  ): Promise<unknown>;
  close?(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Connection input accepted by `createUsageLogQueue`.
 *
 * Pass either a fresh ioredis instance (must NOT have the gateway's
 * `keyPrefix` set — see file-level note) or `RedisOptions` and let BullMQ
 * manage the connection.
 */
export type UsageLogQueueConnection = Redis | RedisOptions;

export interface CreateUsageLogQueueOptions {
  connection: UsageLogQueueConnection;
  /** Override prefix (default `USAGE_LOG_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/** QueueOptions-shaped object passed to the BullMQ Queue constructor. */
export interface BuiltQueueOptions {
  connection: UsageLogQueueConnection;
  prefix: string;
  defaultJobOptions: JobsOptions;
}

/**
 * Pure helper that builds the options object passed to `new Queue(...)`.
 *
 * Exposed for unit testing so the default-options-merge logic can be exercised
 * without standing up a real Redis-backed Queue. `createUsageLogQueue` calls
 * this and forwards the result.
 *
 * The nested `backoff` object is deep-copied so callers that mutate the
 * returned options (or the constructed Queue's defaults) cannot bleed into the
 * shared `USAGE_LOG_DEFAULT_JOB_OPTIONS` constant. Caller-supplied
 * `defaultJobOptions` is spread last so an explicit `backoff` from the caller
 * fully replaces the copied default.
 */
export function buildQueueOptions(
  opts: CreateUsageLogQueueOptions,
): BuiltQueueOptions {
  return {
    connection: opts.connection,
    prefix: opts.prefix ?? USAGE_LOG_QUEUE_PREFIX,
    defaultJobOptions: {
      ...USAGE_LOG_DEFAULT_JOB_OPTIONS,
      backoff: { ...USAGE_LOG_DEFAULT_JOB_OPTIONS.backoff },
      ...(opts.defaultJobOptions ?? {}),
    },
  };
}

/**
 * Build a real BullMQ Queue wired to `aide:gw:usage-log:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueUsageLog`.
 */
export function createUsageLogQueue(
  opts: CreateUsageLogQueueOptions,
): Queue<UsageLogJobPayload> {
  return new Queue<UsageLogJobPayload>(
    USAGE_LOG_QUEUE_NAME,
    buildQueueOptions(opts),
  );
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueUsageLogResult {
  /** The BullMQ job ID — equals `payload.requestId` for dedup. */
  jobId: string;
  /**
   * How the row was persisted.  `"queued"` is the normal happy path
   * (handed off to BullMQ).  `"inline"` means `queue.add` failed and the
   * fallback wrote the row directly inside this call.
   */
  persistence: "queued" | "inline";
}

/**
 * Pino-style logger surface used by the fallback.  Mirrors the shape used by
 * `UsageLogWorker` so callers can pass `fastify.log` directly.
 */
export interface UsageLogFallbackLogger {
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Subset of `prom-client.Counter` we touch in the fallback's "lost" branch.
 * Concrete counter is `gw_usage_persist_lost_total` in `plugins/metrics.ts`;
 * tests can pass any object that satisfies this shape.  Optional so callers
 * that don't care about metrics (e.g., tests) can skip wiring one up.
 *
 * Shape compatible with prom-client's `Counter` — pass
 * `fastify.gwMetrics.usagePersistLostTotal` directly without an adapter.
 */
export interface UsageLogFallbackMetrics {
  inc: () => void;
}

/**
 * Inline-DB fallback wiring (Plan 4A Part 7, Task 7.3).
 *
 * When provided, `enqueueUsageLog` will catch BullMQ enqueue failures and
 * write the validated payload directly to Postgres inside a fresh
 * transaction (via `writeUsageLogBatch`).  When omitted, the original
 * behaviour holds — `queue.add` rejections propagate to the caller.
 *
 * Callers that want fallback behaviour MUST supply both `db` and `logger`.
 * `metrics` is optional (the persistLost counter is rare-event telemetry,
 * not load-bearing for correctness).
 */
export interface UsageLogEnqueueFallback {
  db: Database;
  logger: UsageLogFallbackLogger;
  metrics?: UsageLogFallbackMetrics;
}

export interface EnqueueUsageLogOptions {
  /**
   * Extra per-call BullMQ options. Shallow-merged with the derived `jobId`
   * (`payload.requestId`). Queue-level `defaultJobOptions` (set by
   * `createUsageLogQueue`) supply attempts/backoff/removeOn* automatically —
   * BullMQ merges those into every `add()` call, so we deliberately do NOT
   * re-spread them here (per-call opts win in BullMQ and would silently
   * override Queue-level defaults). Provided primarily for tests / future
   * fallback paths; production callers should pass nothing.
   */
  jobOptions?: JobsOptions;
  /**
   * Inline-DB fallback wiring.  When provided, `queue.add` failures are
   * caught and the row is written via `writeUsageLogBatch` instead.  When
   * omitted, `queue.add` errors propagate (backward compatible with the
   * Task 7.1 callsite that doesn't have a DB handle).
   */
  fallback?: UsageLogEnqueueFallback;
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is set to `payload.requestId` so duplicate enqueues for the same
 *   request are no-ops (BullMQ rejects duplicate job IDs and returns the
 *   existing job).
 * - Per-call opts are kept minimal (jobId + caller overrides only). Queue-
 *   level `defaultJobOptions` from `createUsageLogQueue` cover retries and
 *   retention.
 * - On Zod validation failure this throws — callers should treat that as a
 *   programmer error (the route assembled a bad payload), not a transient
 *   condition. Surface the ZodError details in logs.  Validation runs
 *   BEFORE the `queue.add` attempt so a bad payload never triggers the
 *   fallback path.
 * - On Redis-side failure (`queue.add` rejects):
 *     * If `opts.fallback` is provided, the validated payload is written
 *       directly via `writeUsageLogBatch` in a fresh txn.  Success returns
 *       `{ persistence: "inline" }`.  Inline failure logs a structured
 *       `gw_usage_persist_lost` error, increments the optional metric, and
 *       re-throws the ORIGINAL BullMQ enqueue error (the inline error is
 *       attached as the log entry's `persistError` field — callers see the
 *       proximate Redis cause, not the secondary DB cause, which keeps
 *       upstream classification stable).
 *     * If `opts.fallback` is omitted, the rejection propagates unchanged.
 */
export async function enqueueUsageLog(
  queue: QueueLike,
  payload: unknown,
  opts: EnqueueUsageLogOptions = {},
): Promise<EnqueueUsageLogResult> {
  const validated = UsageLogJobPayload.parse(payload);
  const jobOptions: JobsOptions = {
    ...(opts.jobOptions ?? {}),
    jobId: validated.requestId,
  };

  try {
    await queue.add(USAGE_LOG_JOB_NAME, validated, jobOptions);
    return { jobId: validated.requestId, persistence: "queued" };
  } catch (enqueueError) {
    // No fallback configured — preserve the original Task 7.1 behaviour and
    // let the caller deal with the enqueue failure.
    if (opts.fallback === undefined) {
      throw enqueueError;
    }

    const { db, logger, metrics } = opts.fallback;
    try {
      await writeUsageLogBatch(db, [validated]);
      return { jobId: validated.requestId, persistence: "inline" };
    } catch (persistError) {
      // Both BullMQ AND the inline DB write failed — the row is lost.  Emit
      // a structured log so an operator can replay from the request log if
      // necessary, bump the rare-event counter, and re-throw the original
      // enqueue error.  Re-throwing the BullMQ error (rather than a wrapped
      // "persist lost" error) keeps the caller's error-classification logic
      // stable: callers already handle Redis-side failures of this call.
      //
      // The log + metric calls are wrapped in their own try/catch so a broken
      // logger transport or pino hook can never mask the original BullMQ
      // enqueue error the contract promises to surface.
      try {
        logger.error(
          {
            type: "gw_usage_persist_lost",
            payload: validated,
            enqueueError:
              enqueueError instanceof Error
                ? enqueueError.message
                : String(enqueueError),
            persistError:
              persistError instanceof Error
                ? persistError.message
                : String(persistError),
          },
          "usage log persist lost",
        );
        metrics?.inc?.();
      } catch {
        // logger/metrics failure must not mask the original enqueue error
      }
      throw enqueueError;
    }
  }
}
