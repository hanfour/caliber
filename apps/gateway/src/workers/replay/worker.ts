/**
 * BullMQ replay worker factory (Task 6, single-request-replay).
 *
 * Consumes `caliber:gw:replay` jobs. Each job replays one captured request
 * against a target model and writes the outcome back to `replay_runs`.
 *
 * `concurrency: 1` is deliberate — every replay spends real money on a real
 * upstream call. There is no throughput requirement here (a human presses a
 * button), and serialising the queue makes upstream rate limiting trivial to
 * reason about.
 */

import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  REPLAY_QUEUE_NAME,
  REPLAY_QUEUE_PREFIX,
  ReplayJobPayload,
} from "@caliber/queue";
import { runReplay, type ReplayLogger } from "./runReplay.js";

export interface CreateReplayWorkerOptions {
  connection: Redis;
  db: Database;
  /** Un-prefixed Redis used to read the org eval key (NOT the BullMQ connection). */
  redis: Redis;
  masterKeyHex: string;
  gatewayBaseUrl: string;
  logger?: ReplayLogger;
}

/**
 * Build a BullMQ Worker wired to the `caliber:gw:replay` queue.
 *
 * The payload is re-validated with Zod on the way in (mirroring the evaluator
 * worker): `enqueueReplay` already validated it, but a job can also arrive
 * from an older deploy or a hand-poked Redis key.
 */
export function createReplayWorker(
  opts: CreateReplayWorkerOptions,
): Worker<ReplayJobPayload, void> {
  return new Worker<ReplayJobPayload, void>(
    REPLAY_QUEUE_NAME,
    async (job) => {
      await runReplay({
        db: opts.db,
        redis: opts.redis,
        masterKeyHex: opts.masterKeyHex,
        gatewayBaseUrl: opts.gatewayBaseUrl,
        payload: ReplayJobPayload.parse(job.data),
        logger: opts.logger,
      });
    },
    {
      connection: opts.connection,
      prefix: REPLAY_QUEUE_PREFIX,
      concurrency: 1,
    } satisfies WorkerOptions,
  );
}
