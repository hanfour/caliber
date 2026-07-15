/**
 * github-sync queue (PR1, spec 2026-07-15). Mirrors
 * apps/gateway/src/workers/evaluator/queue.ts. One job per org;
 * deterministic jobId dedups repeat triggers (interval + manual).
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import type { Redis, RedisOptions } from "ioredis";

export const GITHUB_SYNC_QUEUE_NAME = "github-sync";
export const GITHUB_SYNC_QUEUE_PREFIX = "caliber:gw";
export const GITHUB_SYNC_JOB_NAME = "github-sync";

export const GITHUB_SYNC_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

export const GithubSyncJobPayload = z.object({
  orgId: z.string().uuid(),
  triggeredBy: z.enum(["interval", "manual"]),
});
export type GithubSyncJobPayload = z.infer<typeof GithubSyncJobPayload>;

/** BullMQ rejects custom ids containing ':' — keep this colon-free. */
export function buildGithubSyncJobId(input: { orgId: string }): string {
  return ["ghsync", "v1", input.orgId].join("_").replaceAll(":", "-");
}

/** DI seam so tests and the API server can pass fakes (no Redis). */
export interface QueueLike {
  add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown>;
  /**
   * Optional: BullMQ's real `Queue#remove` (see below). Optional so fakes
   * that don't implement it still typecheck — `enqueueGithubSync` treats a
   * missing `remove` as "skip the pre-add cleanup".
   */
  remove?(jobId: string): Promise<unknown>;
  close?(): Promise<void>;
}

export interface CreateGithubSyncQueueOptions {
  connection: Redis | RedisOptions;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createGithubSyncQueue(
  opts: CreateGithubSyncQueueOptions,
): Queue<GithubSyncJobPayload> {
  return new Queue<GithubSyncJobPayload>(GITHUB_SYNC_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? GITHUB_SYNC_QUEUE_PREFIX,
    defaultJobOptions: {
      ...GITHUB_SYNC_DEFAULT_JOB_OPTIONS,
      backoff: { ...GITHUB_SYNC_DEFAULT_JOB_OPTIONS.backoff },
      ...opts.defaultJobOptions,
    },
  });
}

export async function enqueueGithubSync(
  queue: QueueLike,
  payload: unknown,
): Promise<{ jobId: string }> {
  const validated = GithubSyncJobPayload.parse(payload);
  const jobId = buildGithubSyncJobId(validated);
  // BullMQ dedups `add` against the job hash for ANY jobId that still
  // exists — including completed/failed jobs, not just active ones — and
  // that hash is only pruned lazily (on another job in the same queue
  // completing), so our time-component-free jobId would otherwise dedup
  // every tick/syncNow after the first forever. Removing the stale hash
  // first restores "one run per trigger" semantics. `remove` is a no-op
  // for an active/locked job, so an in-flight sync still correctly dedups
  // the add that follows it — this only clears completed/failed hashes.
  // Best-effort: a remove failure (e.g. transient Redis blip) must never
  // block the add.
  try {
    await queue.remove?.(jobId);
  } catch {
    // swallow — see comment above. The add below still proceeds; worst
    // case this particular trigger dedups against a stale hash and the
    // next tick tries again.
  }
  await queue.add(GITHUB_SYNC_JOB_NAME, validated, { jobId });
  return { jobId };
}
