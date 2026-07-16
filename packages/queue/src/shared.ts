/**
 * Shared BullMQ queue primitives for all `@caliber/queue` modules
 * (evaluator, github-sync, github-delivery). Extracted from three
 * lockstep-duplicated apps/gateway/src/workers queue.ts modules — see
 * `evaluator.ts` / `githubSync.ts` / `githubDelivery.ts` for the per-queue
 * names, payloads, and factories that build on top of these primitives.
 */
import type { JobsOptions } from "bullmq";
import type { Redis, RedisOptions } from "ioredis";

/**
 * BullMQ key prefix shared by every caliber gateway queue. Combined with a
 * queue name, this produces Redis keys under `caliber:gw:<queue-name>:*`.
 */
export const CALIBER_QUEUE_PREFIX = "caliber:gw";

/** Default retry / retention policy for all caliber gateway queues. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

/**
 * Connection input accepted by the `create*Queue` factories.
 *
 * Pass either a fresh ioredis instance or `RedisOptions` and let BullMQ
 * manage the connection.
 */
export type QueueConnection = Redis | RedisOptions;

/**
 * Subset of BullMQ's Queue API the enqueue wrappers depend on. Exposed so
 * unit tests can swap in a fake without standing up a real Redis-backed
 * queue.
 *
 * `remove` and `close` are optional so minimal test doubles (or queues that
 * only need `add`) still typecheck — enqueue wrappers treat a missing
 * `remove` as "skip the pre-add cleanup".
 */
export interface QueueLike {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  remove?(jobId: string): Promise<unknown>;
  close?(): Promise<void>;
}

export interface BuildQueueOptionsInput {
  connection: QueueConnection;
  /** Override prefix (default `CALIBER_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/** QueueOptions-shaped object passed to the BullMQ Queue constructor. */
export interface BuiltQueueOptions {
  connection: QueueConnection;
  prefix: string;
  defaultJobOptions: JobsOptions;
}

/**
 * Pure helper that builds the options object passed to `new Queue(...)`.
 *
 * Exposed for unit testing so the default-options-merge logic can be
 * exercised without standing up a real Redis-backed Queue.
 *
 * The nested `backoff` object is deep-copied so callers that mutate the
 * returned options (or the constructed Queue's defaults) cannot bleed into
 * the shared `DEFAULT_JOB_OPTIONS` constant. Caller-supplied
 * `defaultJobOptions` is spread last so an explicit `backoff` from the
 * caller fully replaces the copied default.
 */
export function buildQueueOptions(
  opts: BuildQueueOptionsInput,
): BuiltQueueOptions {
  return {
    connection: opts.connection,
    prefix: opts.prefix ?? CALIBER_QUEUE_PREFIX,
    defaultJobOptions: {
      ...DEFAULT_JOB_OPTIONS,
      backoff: { ...DEFAULT_JOB_OPTIONS.backoff },
      ...(opts.defaultJobOptions ?? {}),
    },
  };
}
