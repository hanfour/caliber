/**
 * github-sync worker (PR1). Concurrency 1: one org sync at a time —
 * network-bound and per-org rate-limited; parallelism buys nothing here.
 */
import { DelayedError, Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  GITHUB_SYNC_QUEUE_NAME,
  GITHUB_SYNC_QUEUE_PREFIX,
  GithubSyncJobPayload,
} from "./queue.js";
import { syncOrg } from "./syncOrg.js";

const RATE_LIMIT_MIN_DELAY_MS = 30_000; // 30s floor
const RATE_LIMIT_MAX_DELAY_MS = 3_600_000; // 1h ceiling
const RATE_LIMIT_DEFAULT_DELAY_MS = 300_000; // 5min, used when reset is unknown

/**
 * Pure helper: how long to delay a rate-limited sync job before retrying.
 * `resetAtMs` comes from `SyncOrgResult.rateLimitResetAtMs` (GitHub's
 * x-ratelimit-reset / retry-after, converted to an epoch-ms timestamp by
 * githubClient.ts — null when GitHub sent no parseable marker).
 *
 * - finite `resetAtMs` in the future → `resetAtMs - nowMs`, clamped to
 *   [minMs, maxMs] so a reset 2s out doesn't hammer GitHub again
 *   immediately, and a reset that's absurdly far out doesn't stall the
 *   org indefinitely.
 * - anything else (null/undefined/NaN/Infinity/already past) → a fixed
 *   5-minute default.
 *
 * `bounds` defaults to the production floor/ceiling; `minMs` is
 * overridable so integration tests can observe a delayed-then-retried job
 * within a sane test timeout without changing production behavior (see
 * `CreateGithubSyncWorkerOptions.rateLimitMinDelayMs`).
 */
export function computeRateLimitDelayMs(
  resetAtMs: number | null | undefined,
  nowMs: number,
  bounds: { minMs?: number; maxMs?: number } = {},
): number {
  const minMs = bounds.minMs ?? RATE_LIMIT_MIN_DELAY_MS;
  const maxMs = bounds.maxMs ?? RATE_LIMIT_MAX_DELAY_MS;
  if (
    typeof resetAtMs === "number" &&
    Number.isFinite(resetAtMs) &&
    resetAtMs > nowMs
  ) {
    return Math.min(Math.max(resetAtMs - nowMs, minMs), maxMs);
  }
  return RATE_LIMIT_DEFAULT_DELAY_MS;
}

export interface CreateGithubSyncWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam: overrides `computeRateLimitDelayMs`'s minimum-delay clamp
   * (production default 30_000ms) so integration tests can prove a
   * rate-limited job actually resumes after its delay without waiting out
   * the full 30s floor. Never set outside tests.
   */
  rateLimitMinDelayMs?: number;
}

export function createGithubSyncWorker(
  opts: CreateGithubSyncWorkerOptions,
): Worker<GithubSyncJobPayload, void> {
  return new Worker<GithubSyncJobPayload, void>(
    GITHUB_SYNC_QUEUE_NAME,
    async (job, token) => {
      const payload = GithubSyncJobPayload.parse(job.data);
      const result = await syncOrg({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        orgId: payload.orgId,
        fetchImpl: opts.fetchImpl,
      });
      // Spec: rate-limited syncs must wait out GitHub's actual reset window
      // rather than burn BullMQ's fixed exponential backoff (1s/2s/4s,
      // attempts: 3) — that backoff would be fully exhausted long before a
      // minutes-long GitHub rate-limit window clears, failing the job for
      // good. `job.moveToDelayed` + throwing `DelayedError` reschedules
      // THIS SAME job at the computed delay: it doesn't consume an attempt
      // (BullMQ's handleFailed special-cases DelayedError, see
      // node_modules/bullmq dist/esm/classes/worker.js `handleFailed`) and
      // it doesn't block other orgs' jobs (each org is a separate job; a
      // delayed job simply isn't picked up again until its delay elapses).
      //
      // Interplay with interval.ts: the 6h scheduler's remove-before-add
      // dedup (enqueueGithubSync) may remove this DELAYED job and re-add it
      // fresh before the delay elapses. That's fine — the re-added job
      // reruns syncOrg, which re-classifies and re-delays if still
      // rate-limited; self-correcting, no special handling needed here.
      if (result.status === "rate_limited") {
        const delayMs = computeRateLimitDelayMs(
          result.rateLimitResetAtMs,
          Date.now(),
          { minMs: opts.rateLimitMinDelayMs },
        );
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }
    },
    {
      connection: opts.connection,
      prefix: GITHUB_SYNC_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 1,
    } satisfies WorkerOptions,
  );
}
