/**
 * github-sync worker (PR1). Concurrency 1: one org sync at a time —
 * network-bound and per-org rate-limited; parallelism buys nothing here.
 */
import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  GITHUB_SYNC_QUEUE_NAME,
  GITHUB_SYNC_QUEUE_PREFIX,
  GithubSyncJobPayload,
} from "./queue.js";
import { syncOrg } from "./syncOrg.js";

export interface CreateGithubSyncWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export function createGithubSyncWorker(
  opts: CreateGithubSyncWorkerOptions,
): Worker<GithubSyncJobPayload, void> {
  return new Worker<GithubSyncJobPayload, void>(
    GITHUB_SYNC_QUEUE_NAME,
    async (job) => {
      const payload = GithubSyncJobPayload.parse(job.data);
      const result = await syncOrg({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        orgId: payload.orgId,
        fetchImpl: opts.fetchImpl,
      });
      // Spec: rate-limited syncs reschedule themselves. Watermarks already
      // advanced for completed repos; throwing hands the retry to BullMQ's
      // exponential backoff (attempts: 3).
      if (result.status === "rate_limited") {
        throw new Error("github rate limited; retrying via job backoff");
      }
    },
    {
      connection: opts.connection,
      prefix: GITHUB_SYNC_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 1,
    } satisfies WorkerOptions,
  );
}
