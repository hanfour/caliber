/**
 * BullMQ queue + thin wrapper for body capture writes (Plan 4B Part 3, Task 3.4).
 *
 * Design notes:
 *   - Queue name "body-capture" with prefix "caliber:gw" yields Redis keys under
 *     `caliber:gw:body-capture:*`, matching the design-doc identifier.
 *
 *   - Body capture is best-effort / opt-in: no inline fallback. If Redis is
 *     unavailable the capture is dropped (caller should emit a metric). This
 *     is intentionally simpler than the usage-log queue.
 *
 *   - jobId = requestId for BullMQ dedup. Duplicate enqueues for the same
 *     requestId are no-ops (BullMQ returns the existing job).
 *
 *   - This module exports a `QueueLike` interface so unit tests can inject a
 *     fake without standing up a real Redis-backed queue.
 */

import { Queue, type JobsOptions, type RedisOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const BODY_CAPTURE_QUEUE_NAME = "body-capture";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `caliber:gw:body-capture:*`.
 */
export const BODY_CAPTURE_QUEUE_PREFIX = "caliber:gw";

/** BullMQ job name used for every body-capture write. */
export const BODY_CAPTURE_JOB_NAME = "body-capture";

/** Default retry / retention policy for body-capture jobs. */
export const BODY_CAPTURE_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
} as const satisfies JobsOptions;

// ── Payload schema ───────────────────────────────────────────────────────────

/**
 * Job payload validated at enqueue time. Carries raw body strings (worker
 * pipelines sanitize → truncate → encrypt) plus cleartext metadata columns.
 */
export const BodyCaptureJobPayload = z.object({
  requestId: z.string().min(1),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  // Raw body strings; worker pipelines sanitize → truncate → encrypt
  requestBody: z.string(),
  responseBody: z.string(),
  thinkingBody: z.string().nullable().default(null),
  attemptErrors: z.string().nullable().default(null),
  // Cleartext metadata going to request_bodies directly (not encrypted)
  requestParams: z.unknown().nullable().default(null),
  stopReason: z.string().nullable().default(null),
  clientUserAgent: z.string().nullable().default(null),
  clientSessionId: z.string().nullable().default(null),
  attachmentsMeta: z.unknown().nullable().default(null),
  cacheControlMarkers: z.unknown().nullable().default(null),
  // Retention calculation hint (in days)
  retentionDays: z.number().int().positive().default(90),
});

export type BodyCaptureJobPayload = z.infer<typeof BodyCaptureJobPayload>;

// ── Queue interface (for DI in tests) ────────────────────────────────────────

/**
 * Subset of BullMQ's Queue API that this module depends on. Exposed so unit
 * tests can swap in a fake without standing up a real Redis-backed queue.
 */
export interface QueueLike {
  add(
    name: string,
    data: BodyCaptureJobPayload,
    opts?: JobsOptions,
  ): Promise<unknown>;
  close?(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export type BodyCaptureQueueConnection = Redis | RedisOptions;

export interface CreateBodyCaptureQueueOptions {
  connection: BodyCaptureQueueConnection;
  /** Override prefix (default `BODY_CAPTURE_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

export interface BuiltQueueOptions {
  connection: BodyCaptureQueueConnection;
  prefix: string;
  defaultJobOptions: JobsOptions;
}

/**
 * Pure helper that builds the options object passed to `new Queue(...)`.
 *
 * Exposed for unit testing so the default-options-merge logic can be exercised
 * without standing up a real Redis-backed Queue. `createBodyCaptureQueue` calls
 * this and forwards the result.
 *
 * The nested `backoff` object is deep-copied so callers that mutate the
 * returned options cannot bleed into the shared constant.
 */
export function buildQueueOptions(
  opts: CreateBodyCaptureQueueOptions,
): BuiltQueueOptions {
  return {
    connection: opts.connection,
    prefix: opts.prefix ?? BODY_CAPTURE_QUEUE_PREFIX,
    defaultJobOptions: {
      ...BODY_CAPTURE_DEFAULT_JOB_OPTIONS,
      backoff: { ...BODY_CAPTURE_DEFAULT_JOB_OPTIONS.backoff },
      ...(opts.defaultJobOptions ?? {}),
    },
  };
}

/**
 * Build a real BullMQ Queue wired to `caliber:gw:body-capture:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueBodyCapture`.
 */
export function createBodyCaptureQueue(
  opts: CreateBodyCaptureQueueOptions,
): Queue<BodyCaptureJobPayload> {
  return new Queue<BodyCaptureJobPayload>(
    BODY_CAPTURE_QUEUE_NAME,
    buildQueueOptions(opts),
  );
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueBodyCaptureResult {
  /** The BullMQ job ID — equals `payload.requestId` for dedup. */
  jobId: string;
  /** Body capture is best-effort; "queued" is the only persistence mode. */
  persistence: "queued";
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is set to `payload.requestId` so duplicate enqueues for the same
 *   request are no-ops (BullMQ rejects duplicate job IDs).
 * - On Zod validation failure this throws — treat as a programmer error.
 * - On Redis-side failure (`queue.add` rejects), the error propagates.
 *   Body capture is best-effort; the caller should catch and emit a metric.
 */
export async function enqueueBodyCapture(
  queue: QueueLike,
  payload: unknown,
): Promise<EnqueueBodyCaptureResult> {
  const validated = BodyCaptureJobPayload.parse(payload);
  await queue.add(BODY_CAPTURE_JOB_NAME, validated, {
    jobId: validated.requestId,
  });
  return { jobId: validated.requestId, persistence: "queued" };
}
