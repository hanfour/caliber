/**
 * BullMQ queue + thin wrapper for single-request replay jobs (Task 4;
 * see .superpowers/sdd/2026-08-03-single-request-replay/task-4-brief.md).
 *
 * Design notes:
 *   - Queue name "replay" with prefix "caliber:gw" yields Redis keys under
 *     `caliber:gw:replay:*`, matching the sibling evaluator/github queues.
 *
 *   - jobId is the bare `runId` (a uuid, from `replay_runs.id`), with no
 *     colon and no composed string. BullMQ 5.x throws `Custom Id cannot
 *     contain :` for ids that contain `:` and don't split into exactly 3
 *     parts — a colon jobId silently broke evaluator enqueueing in v0.17.1
 *     of this project. Using the bare runId also gives free retry dedup: a
 *     redelivered job for the same run cannot enqueue a second replay,
 *     which matters because each replay spends real money.
 */

import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import {
  CALIBER_QUEUE_PREFIX,
  DEFAULT_JOB_OPTIONS,
  buildQueueOptions,
  type QueueConnection,
  type QueueLike,
} from "./shared.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const REPLAY_QUEUE_NAME = "replay";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `caliber:gw:replay:*`.
 *
 * Alias for `CALIBER_QUEUE_PREFIX`, kept so callers can import a
 * replay-specific name symmetrically with `EVALUATOR_QUEUE_PREFIX`.
 */
export const REPLAY_QUEUE_PREFIX = CALIBER_QUEUE_PREFIX;

/** BullMQ job name used for every replay job. */
export const REPLAY_JOB_NAME = "replay";

/**
 * Default retry / retention policy for replay jobs.
 * Alias for `DEFAULT_JOB_OPTIONS`.
 */
export const REPLAY_DEFAULT_JOB_OPTIONS = DEFAULT_JOB_OPTIONS;

// ── Payload schema ───────────────────────────────────────────────────────────

/**
 * Job payload validated at enqueue time. Carries everything the gateway
 * worker needs to replay a single historical request against a (possibly
 * different) model.
 */
export const ReplayJobPayload = z.object({
  /** replay_runs.id — also used directly as the BullMQ jobId. Bare uuid, no colon. */
  runId: z.string().uuid(),
  orgId: z.string().uuid(),
  sourceRequestId: z.string().min(1),
  targetModel: z.string().min(1),
});

export type ReplayJobPayload = z.infer<typeof ReplayJobPayload>;

// ── Factory ──────────────────────────────────────────────────────────────────

export interface CreateReplayQueueOptions {
  connection: QueueConnection;
  /** Override prefix (default `REPLAY_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/**
 * Build a real BullMQ Queue wired to `caliber:gw:replay:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueReplay`.
 */
export function createReplayQueue(
  opts: CreateReplayQueueOptions,
): Queue<ReplayJobPayload> {
  return new Queue<ReplayJobPayload>(REPLAY_QUEUE_NAME, buildQueueOptions(opts));
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueReplayResult {
  /** The BullMQ job ID — the bare `runId` uuid (no colon). */
  jobId: string;
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is the bare `runId` — never composed with a colon or any other
 *   separator. BullMQ 5.x rejects custom ids that contain `:` unless they
 *   split into exactly 3 parts; a colon jobId silently broke evaluator
 *   enqueueing in v0.17.1. Using the bare uuid also gives free retry dedup:
 *   a redelivered job for the same run cannot produce a second replay,
 *   which matters because each replay spends real money.
 * - On Zod validation failure this throws — treat as a programmer error
 *   (the caller assembled a bad payload), not a transient condition.
 * - On Redis-side failure (`queue.add` rejects), the error propagates to
 *   the caller.
 */
export async function enqueueReplay(
  queue: QueueLike,
  payload: unknown,
): Promise<EnqueueReplayResult> {
  const validated = ReplayJobPayload.parse(payload);

  await queue.add(REPLAY_JOB_NAME, validated, { jobId: validated.runId });

  return { jobId: validated.runId };
}
