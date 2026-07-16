/** github-delivery worker (PR2). Concurrency 1 — scoring is DB-bound. */
import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  GITHUB_DELIVERY_QUEUE_NAME,
  GITHUB_DELIVERY_QUEUE_PREFIX,
  GithubDeliveryJobPayload,
} from "./queue.js";
import { runDeliveryEval, type LoggerLike } from "./runDeliveryEval.js";

export interface CreateGithubDeliveryWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
  /** Test seam; threaded to the staleness-gated inline sync. */
  fetchImpl?: typeof fetch;
  /** Threaded to runDeliveryEval so an inline-sync failure surfaces. */
  logger?: LoggerLike;
}

export function createGithubDeliveryWorker(
  opts: CreateGithubDeliveryWorkerOptions,
): Worker<GithubDeliveryJobPayload, void> {
  return new Worker<GithubDeliveryJobPayload, void>(
    GITHUB_DELIVERY_QUEUE_NAME,
    async (job) => {
      const payload = GithubDeliveryJobPayload.parse(job.data);
      await runDeliveryEval({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        payload,
        fetchImpl: opts.fetchImpl,
        logger: opts.logger,
      });
    },
    {
      connection: opts.connection,
      prefix: GITHUB_DELIVERY_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 1,
    } satisfies WorkerOptions,
  );
}
