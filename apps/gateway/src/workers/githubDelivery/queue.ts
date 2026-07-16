/**
 * github-delivery queue (PR2, spec 2026-07-15 Component 3). One job per
 * (org, user, window). jobIds are time-bucketed (periodStart embedded) so
 * distinct windows never dedup against each other. Manual regeneration
 * removes the stale completed/failed hash first (BullMQ 5 dedups adds
 * against finished jobs; Queue#remove no-ops on active jobs, so an
 * in-flight computation still dedups). The cron path adds plainly —
 * same-Monday repeats are MEANT to dedup against the completed hash.
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import type { Redis, RedisOptions } from "ioredis";
import type { QueueLike } from "../githubSync/queue.js";

export const GITHUB_DELIVERY_QUEUE_NAME = "github-delivery";
export const GITHUB_DELIVERY_QUEUE_PREFIX = "caliber:gw";
export const GITHUB_DELIVERY_JOB_NAME = "github-delivery";

export const GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

export const GithubDeliveryJobPayload = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  periodType: z.literal("daily"),
  triggeredBy: z.enum(["cron", "manual"]),
});
export type GithubDeliveryJobPayload = z.infer<typeof GithubDeliveryJobPayload>;

/** Colon-free (BullMQ rejects ':') and time-bucketed (PR1 C1 lesson). */
export function buildGithubDeliveryJobId(input: {
  orgId: string;
  userId: string;
  periodStart: string;
}): string {
  return ["ghdel", "v1", input.orgId, input.userId, input.periodStart]
    .join("_")
    .replaceAll(":", "-");
}

export interface CreateGithubDeliveryQueueOptions {
  connection: Redis | RedisOptions;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createGithubDeliveryQueue(
  opts: CreateGithubDeliveryQueueOptions,
): Queue<GithubDeliveryJobPayload> {
  return new Queue<GithubDeliveryJobPayload>(GITHUB_DELIVERY_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? GITHUB_DELIVERY_QUEUE_PREFIX,
    defaultJobOptions: {
      ...GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS,
      backoff: { ...GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS.backoff },
      ...opts.defaultJobOptions,
    },
  });
}

export async function enqueueGithubDelivery(
  queue: QueueLike,
  payload: unknown,
  opts?: { regenerate?: boolean },
): Promise<{ jobId: string }> {
  const validated = GithubDeliveryJobPayload.parse(payload);
  const jobId = buildGithubDeliveryJobId(validated);
  if (opts?.regenerate) {
    try {
      await queue.remove?.(jobId);
    } catch {
      // Removal is best-effort; never block the add.
    }
  }
  await queue.add(GITHUB_DELIVERY_JOB_NAME, validated, { jobId });
  return { jobId };
}
