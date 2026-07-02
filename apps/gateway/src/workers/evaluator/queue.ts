/**
 * BullMQ queue + thin wrapper for evaluator jobs (Plan 4B Part 4, Task 4.1).
 *
 * Design notes:
 *   - Queue name "evaluator" with prefix "caliber:gw" yields Redis keys under
 *     `caliber:gw:evaluator:*`, matching the design-doc identifier.
 *
 *   - Job payload uses ISO 8601 datetime strings (not Date objects) because
 *     BullMQ JSON-serializes payloads. Dates become strings after JSON
 *     round-trip, so being explicit avoids silent coercion bugs in the worker.
 *
 *   - jobId is derived by `buildEvaluatorJobId` (from `@caliber/evaluator`),
 *     producing a colon-free, underscore-joined string. BullMQ 5.x throws
 *     `Custom Id cannot contain :` for ids that contain `:` and don't split
 *     into exactly 3 parts; ISO periodStart has multiple colons and would
 *     trigger that error with a naive template literal. The shared builder is
 *     also used by `apps/api reports.ts` rerun so cron and admin-rerun dedup
 *     correctly against each other.
 *
 *   - This module exports a `QueueLike` interface so unit tests can inject a
 *     fake without standing up a real Redis-backed queue.
 */

import { Queue, type JobsOptions, type RedisOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { buildEvaluatorJobId } from "@caliber/evaluator";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const EVALUATOR_QUEUE_NAME = "evaluator";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `caliber:gw:evaluator:*`, matching the design-doc identifier
 * "caliber:gw:evaluator".
 */
export const EVALUATOR_QUEUE_PREFIX = "caliber:gw";

/** BullMQ job name used for every evaluator job. */
export const EVALUATOR_JOB_NAME = "evaluator";

/** Default retry / retention policy for evaluator jobs. */
export const EVALUATOR_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

// ── Payload schema ───────────────────────────────────────────────────────────

const UUID = z.string().uuid();
const ISO_DATETIME = z.string().datetime();

/**
 * Job payload validated at enqueue time. Carries evaluation request metadata:
 * org and user scope, evaluation period (start/end as ISO strings), period
 * type (daily/weekly/monthly), and audit trail of who triggered it.
 *
 * PR3 adds optional per-key fields:
 *   - `apiKeyId`: when set, scopes the evaluation to a single api_key (per-key
 *     grain).  When absent, the per-person grain is used (byte-identical).
 *   - `keyNameSnapshot`: snapshot of `api_keys.name` at enqueue time.  Stored
 *     in `evaluation_reports_by_key.key_name_snapshot` so the report label
 *     survives future renames/revocations.  Required (non-empty) when
 *     `apiKeyId` is set; ignored otherwise.  Enforced via `.refine()` so
 *     the cron always supplies it and the worker never silently receives "".
 *
 * PR4 adds:
 *   - 4-part jobId derivation when `apiKeyId` is present (in `enqueueEvaluator`).
 *   - Zod `.refine()` co-presence: `apiKeyId` set → `keyNameSnapshot` required
 *     and non-empty.
 */
export const EvaluatorJobPayload = z
  .object({
    orgId: UUID,
    userId: UUID,
    periodStart: ISO_DATETIME,
    periodEnd: ISO_DATETIME,
    periodType: z.enum(["daily", "weekly", "monthly"]),
    triggeredBy: z.enum(["cron", "admin_rerun", "manual"]),
    triggeredByUser: UUID.nullable().default(null),
    /** Per-key grain (PR3): api_key UUID to evaluate. Absent → per-person. */
    apiKeyId: UUID.optional(),
    /** Per-key grain (PR3+PR4): snapshot of the key name at enqueue time.
     *  Required and non-empty when `apiKeyId` is set (enforced by refine). */
    keyNameSnapshot: z.string().optional(),
  })
  .refine(
    (d) =>
      d.apiKeyId === undefined ||
      (typeof d.keyNameSnapshot === "string" && d.keyNameSnapshot.length > 0),
    {
      message:
        "keyNameSnapshot must be a non-empty string when apiKeyId is set",
      path: ["keyNameSnapshot"],
    },
  );

export type EvaluatorJobPayload = z.infer<typeof EvaluatorJobPayload>;

// ── Queue interface (for DI in tests) ────────────────────────────────────────

/**
 * Subset of BullMQ's Queue API that this module depends on. Exposed so unit
 * tests can swap in a fake without standing up a real Redis-backed queue.
 *
 * Note: `add` returns `Promise<unknown>` because the wrapper does not consume
 * the return value — `enqueueEvaluator` derives `jobId` from the validated
 * payload itself and returns that to the caller.
 */
export interface QueueLike {
  add(
    name: string,
    data: EvaluatorJobPayload,
    opts?: JobsOptions,
  ): Promise<unknown>;
  close?(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Connection input accepted by `createEvaluatorQueue`.
 *
 * Pass either a fresh ioredis instance or `RedisOptions` and let BullMQ
 * manage the connection.
 */
export type EvaluatorQueueConnection = Redis | RedisOptions;

export interface CreateEvaluatorQueueOptions {
  connection: EvaluatorQueueConnection;
  /** Override prefix (default `EVALUATOR_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/** QueueOptions-shaped object passed to the BullMQ Queue constructor. */
export interface BuiltQueueOptions {
  connection: EvaluatorQueueConnection;
  prefix: string;
  defaultJobOptions: JobsOptions;
}

/**
 * Pure helper that builds the options object passed to `new Queue(...)`.
 *
 * Exposed for unit testing so the default-options-merge logic can be exercised
 * without standing up a real Redis-backed Queue. `createEvaluatorQueue` calls
 * this and forwards the result.
 *
 * The nested `backoff` object is deep-copied so callers that mutate the
 * returned options (or the constructed Queue's defaults) cannot bleed into the
 * shared `EVALUATOR_DEFAULT_JOB_OPTIONS` constant. Caller-supplied
 * `defaultJobOptions` is spread last so an explicit `backoff` from the caller
 * fully replaces the copied default.
 */
export function buildQueueOptions(
  opts: CreateEvaluatorQueueOptions,
): BuiltQueueOptions {
  return {
    connection: opts.connection,
    prefix: opts.prefix ?? EVALUATOR_QUEUE_PREFIX,
    defaultJobOptions: {
      ...EVALUATOR_DEFAULT_JOB_OPTIONS,
      backoff: { ...EVALUATOR_DEFAULT_JOB_OPTIONS.backoff },
      ...(opts.defaultJobOptions ?? {}),
    },
  };
}

/**
 * Build a real BullMQ Queue wired to `caliber:gw:evaluator:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueEvaluator`.
 */
export function createEvaluatorQueue(
  opts: CreateEvaluatorQueueOptions,
): Queue<EvaluatorJobPayload> {
  return new Queue<EvaluatorJobPayload>(
    EVALUATOR_QUEUE_NAME,
    buildQueueOptions(opts),
  );
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueEvaluatorResult {
  /**
   * The BullMQ job ID — produced by `buildEvaluatorJobId` (colon-free).
   *
   * - Per-person (apiKeyId absent): `${userId}_${periodStart}_${periodType}`
   *   with all `:` replaced by `-`.
   * - Per-key (apiKeyId present): `${userId}_${apiKeyId}_${periodStart}_${periodType}`
   *   with all `:` replaced by `-`.
   *
   * The two formats can never collide: a UUID apiKeyId contains no year-digit
   * ISO-datetime prefix, and the segment count differs by one.
   */
  jobId: string;
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is derived by `buildEvaluatorJobId` (from `@caliber/evaluator`), which
 *   produces a colon-free, underscore-joined id. BullMQ 5.x rejects custom ids
 *   that contain `:` unless they split into exactly 3 parts; ISO periodStart
 *   embeds multiple colons and would trigger that error with a naive template
 *   literal. The shared builder is also used by `apps/api reports.ts` rerun so
 *   cron and admin-rerun always produce the same id for the same inputs (dedup).
 * - Collision safety: per-person (3 segments) can never equal per-key (4 segments)
 *   because a UUID apiKeyId never looks like an ISO periodStart.
 * - On Zod validation failure this throws — treat as a programmer error
 *   (the caller assembled a bad payload), not a transient condition.
 * - On Redis-side failure (`queue.add` rejects), the error propagates.
 *   Evaluator jobs are not best-effort like body capture; the caller should
 *   handle enqueue failures appropriately.
 */
export async function enqueueEvaluator(
  queue: QueueLike,
  payload: unknown,
): Promise<EnqueueEvaluatorResult> {
  const validated = EvaluatorJobPayload.parse(payload);
  const jobId = buildEvaluatorJobId(validated);

  await queue.add(EVALUATOR_JOB_NAME, validated, { jobId });

  return { jobId };
}
