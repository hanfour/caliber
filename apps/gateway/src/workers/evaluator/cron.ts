/**
 * Daily evaluator cron (Plan 4B Part 4, Task 4.3).
 *
 * Every 24h at 00:05 UTC:
 *   1. Query orgs with contentCaptureEnabled=true AND deletedAt IS NULL.
 *   2. For each org, enumerate active users (organization_members with user record).
 *   3. For each user, enqueue an evaluator job with periodStart = yesterday UTC 00:00,
 *      periodEnd = today UTC 00:00, periodType = "daily", triggeredBy = "cron".
 *   4. Job dedup is handled by BullMQ: jobId = userId:periodStart:periodType, so
 *      re-running within the same UTC day is idempotent.
 *
 * Design notes:
 *   - Uses interval-based scheduling (setInterval) to match the repo's existing
 *     cron patterns (bodyPurge, billingAudit). No cron-expression parser.
 *   - Runs immediately on start, then every 24h. UTC alignment is best-effort:
 *     if the server starts outside the 00:05 UTC window, the cron handles the
 *     prior day's data on first tick. Idempotency via jobId dedup ensures no
 *     double-enqueues.
 *   - enqueueFailures are counted separately and logged; operationally important
 *     if Redis/BullMQ is flapping.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations, organizationMembers, users } from "@caliber/db";
import {
  enqueueEvaluator,
  type QueueLike as EvaluatorQueueLike,
} from "./queue.js";

export const EVALUATOR_CRON_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const EVALUATOR_CRON_HOUR_UTC = 0;
export const EVALUATOR_CRON_MINUTE_UTC = 5;

export interface EnqueueDailyResult {
  orgsConsidered: number;
  membersEnumerated: number;
  jobsEnqueued: number;
  enqueueFailures: number;
}

export interface EnqueueDailyInput {
  db: Database;
  queue: EvaluatorQueueLike;
  now?: () => Date; // Override for tests
}

/**
 * Idempotent — runs against today's data; job dedup via jobId means re-runs
 * within the same UTC day are no-ops.
 */
export async function enqueueDailyEvaluatorJobs(
  input: EnqueueDailyInput,
): Promise<EnqueueDailyResult> {
  const { db, queue, now = () => new Date() } = input;
  const currentUtc = now();
  const today00Utc = new Date(
    Date.UTC(
      currentUtc.getUTCFullYear(),
      currentUtc.getUTCMonth(),
      currentUtc.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const yesterday00Utc = new Date(today00Utc.getTime() - 24 * 60 * 60 * 1000);

  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.contentCaptureEnabled, true),
        isNull(organizations.deletedAt),
      ),
    );

  let membersEnumerated = 0;
  let jobsEnqueued = 0;
  let enqueueFailures = 0;

  for (const org of orgs) {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, org.id));

    for (const m of members) {
      membersEnumerated += 1;
      try {
        await enqueueEvaluator(queue, {
          orgId: org.id,
          userId: m.userId,
          periodStart: yesterday00Utc.toISOString(),
          periodEnd: today00Utc.toISOString(),
          periodType: "daily",
          triggeredBy: "cron",
          triggeredByUser: null,
        });
        jobsEnqueued += 1;
      } catch {
        enqueueFailures += 1;
      }
    }
  }

  return {
    orgsConsidered: orgs.length,
    membersEnumerated,
    jobsEnqueued,
    enqueueFailures,
  };
}

// ── Cron handle ─────────────────────────────────────────────────────────────

export interface StartEvaluatorCronOptions {
  db: Database;
  queue: EvaluatorQueueLike;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
  intervalMs?: number;
}

export interface EvaluatorCronHandle {
  stop: () => void;
  tick: () => Promise<void>;
}

export function startEvaluatorCron(
  opts: StartEvaluatorCronOptions,
): EvaluatorCronHandle {
  const interval = opts.intervalMs ?? EVALUATOR_CRON_INTERVAL_MS;
  let stopped = false;
  let currentTick: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const result = await enqueueDailyEvaluatorJobs({
        db: opts.db,
        queue: opts.queue,
      });
      opts.logger.info(result, "evaluator daily cron tick completed");
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "evaluator daily cron tick failed",
      );
    }
  }

  // Run immediately on start, then on interval
  currentTick = runTick();
  const timer = setInterval(() => {
    currentTick = runTick();
  }, interval);

  // Don't keep process alive solely for this timer
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick: async () => {
      await currentTick;
      await runTick();
    },
  };
}
