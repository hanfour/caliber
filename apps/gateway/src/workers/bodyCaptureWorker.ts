/**
 * BullMQ worker for body capture (Plan 4B Part 3, Task 3.4).
 *
 * Processes jobs from `caliber:gw:body-capture:*`, running the full
 * sanitize → truncate → encrypt → INSERT pipeline for each job.
 *
 * Concurrency is 4 per plan spec. Each job is independent so there is no
 * batching — one job = one DB INSERT (with ON CONFLICT DO NOTHING for retries).
 */

import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  BODY_CAPTURE_QUEUE_NAME,
  BODY_CAPTURE_QUEUE_PREFIX,
  BodyCaptureJobPayload,
} from "./bodyCaptureQueue.js";
import { persistBody } from "./bodyCapturePersist.js";

export interface CreateBodyCaptureWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  /** Default 4 per plan spec. */
  concurrency?: number;
}

/**
 * Construct a BullMQ Worker that processes body-capture jobs.
 *
 * The worker:
 *  1. Parses + validates job data via the Zod schema.
 *  2. Delegates to `persistBody` for the full sanitize → truncate → encrypt
 *     → INSERT pipeline.
 *  3. On failure, lets the error propagate so BullMQ retries per the queue's
 *     `attempts` policy (default 3 × exponential backoff).
 */
export function createBodyCaptureWorker(
  opts: CreateBodyCaptureWorkerOptions,
): Worker<BodyCaptureJobPayload, void> {
  return new Worker<BodyCaptureJobPayload, void>(
    BODY_CAPTURE_QUEUE_NAME,
    async (job) => {
      const payload = BodyCaptureJobPayload.parse(job.data);
      await persistBody({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        payload,
      });
    },
    {
      connection: opts.connection,
      prefix: BODY_CAPTURE_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 4,
    } satisfies WorkerOptions,
  );
}
