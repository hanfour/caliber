/**
 * github-sync queue (PR1, spec 2026-07-15; extracted from
 * apps/gateway/src/workers/githubSync/queue.ts). One job per org;
 * deterministic jobId dedups repeat triggers (interval + manual).
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import {
  CALIBER_QUEUE_PREFIX,
  buildQueueOptions,
  type QueueConnection,
  type QueueLike,
} from "./shared.js";

export const GITHUB_SYNC_QUEUE_NAME = "github-sync";
/** Legacy alias for `CALIBER_QUEUE_PREFIX`. */
export const GITHUB_SYNC_QUEUE_PREFIX = CALIBER_QUEUE_PREFIX;
export const GITHUB_SYNC_JOB_NAME = "github-sync";

export const GithubSyncJobPayload = z.object({
  orgId: z.string().uuid(),
  triggeredBy: z.enum(["interval", "manual"]),
});
export type GithubSyncJobPayload = z.infer<typeof GithubSyncJobPayload>;

/** BullMQ rejects custom ids containing ':' — keep this colon-free. */
export function buildGithubSyncJobId(input: { orgId: string }): string {
  return ["ghsync", "v1", input.orgId].join("_").replaceAll(":", "-");
}

export interface CreateGithubSyncQueueOptions {
  connection: QueueConnection;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createGithubSyncQueue(
  opts: CreateGithubSyncQueueOptions,
): Queue<GithubSyncJobPayload> {
  return new Queue<GithubSyncJobPayload>(
    GITHUB_SYNC_QUEUE_NAME,
    buildQueueOptions(opts),
  );
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
