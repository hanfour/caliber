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
  /** Required — threaded to runDeliveryEval's LLM quality layer (loopback
   * eval-key lookup). Same instance the worker uses for its BullMQ
   * connection is fine — it's an un-prefixed client either way. */
  redis: Redis;
  /** Required — base URL runDeliveryEval's quality layer targets for the
   * loopback /v1/messages call. */
  gatewayBaseUrl: string;
  concurrency?: number;
  /** Test seam; threaded to the staleness-gated inline sync AND the
   * quality layer's GitHub/LLM-loopback fetches. */
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
        redis: opts.redis,
        gatewayBaseUrl: opts.gatewayBaseUrl,
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
