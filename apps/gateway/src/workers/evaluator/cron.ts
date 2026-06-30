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

import { and, eq, exists, gte, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  apiKeys,
  organizations,
  organizationMembers,
  usageLogs,
  users,
} from "@caliber/db";
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
  /**
   * PR4 — per-key pass counters (all zero when enableProjectEvaluation=false).
   *
   * keyCandidates  – opted-in, non-revoked keys with traffic in the window
   *                  (before the per-user cap is applied).
   * keyJobsEnqueued – successfully enqueued per-key evaluator jobs.
   * keyJobsCapped   – keys skipped because the per-user cap was reached.
   */
  keyCandidates: number;
  keyJobsEnqueued: number;
  keyJobsCapped: number;
}

export interface EnqueueDailyInput {
  db: Database;
  queue: EvaluatorQueueLike;
  now?: () => Date; // Override for tests
  /**
   * PR4 dark-launch flag.  When true, the second (per-key) cron pass runs
   * after the existing per-person pass.  Default: false.
   */
  enableProjectEvaluation?: boolean;
  /**
   * PR4 per-user cap: maximum number of opted-in api_keys per user per org
   * that may be enqueued in a single cron tick.  Over-cap keys are counted
   * in `keyJobsCapped`.  Default: 20.
   */
  maxProjectKeysPerUser?: number;
}

/**
 * Idempotent — runs against today's data; job dedup via jobId means re-runs
 * within the same UTC day are no-ops.
 *
 * PR4: a second, additive per-key pass runs when `enableProjectEvaluation`
 * is true, enqueuing per-(user×key) jobs for opted-in api_keys that had
 * traffic in the window.  The per-person pass is 100% unchanged.
 */
export async function enqueueDailyEvaluatorJobs(
  input: EnqueueDailyInput,
): Promise<EnqueueDailyResult> {
  const {
    db,
    queue,
    now = () => new Date(),
    enableProjectEvaluation = false,
    maxProjectKeysPerUser = 20,
  } = input;
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

  // ── Per-person pass (unchanged from pre-PR4) ─────────────────────────────
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

  // ── Per-key pass (PR4 dark-launch — ENABLE_PROJECT_EVALUATION) ───────────
  let keyCandidates = 0;
  let keyJobsEnqueued = 0;
  let keyJobsCapped = 0;

  if (enableProjectEvaluation) {
    for (const org of orgs) {
      // Spec §4 query: opted-in, non-revoked keys that had traffic in the window.
      // The EXISTS(...) subquery is the cost valve: idle/revoked/non-opted
      // keys produce zero enqueue calls.
      const keyRows = await db
        .selectDistinct({
          id: apiKeys.id,
          userId: apiKeys.userId,
          orgId: apiKeys.orgId,
          teamId: apiKeys.teamId,
          name: apiKeys.name,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.orgId, org.id),
            eq(apiKeys.evaluateAsProject, true),
            isNull(apiKeys.revokedAt),
            exists(
              db
                .select({ one: sql<number>`1` })
                .from(usageLogs)
                .where(
                  and(
                    eq(usageLogs.apiKeyId, apiKeys.id),
                    gte(usageLogs.createdAt, yesterday00Utc),
                    lt(usageLogs.createdAt, today00Utc),
                  ),
                ),
            ),
          ),
        );

      // Group by userId so the per-user cap applies within each org.
      const keysByUser = new Map<string, typeof keyRows>();
      for (const keyRow of keyRows) {
        keyCandidates += 1;
        const existing = keysByUser.get(keyRow.userId) ?? [];
        keysByUser.set(keyRow.userId, [...existing, keyRow]);
      }

      for (const [, userKeys] of keysByUser) {
        const cappedKeys = userKeys.slice(0, maxProjectKeysPerUser);
        keyJobsCapped += userKeys.length - cappedKeys.length;

        for (const keyRow of cappedKeys) {
          try {
            await enqueueEvaluator(queue, {
              orgId: keyRow.orgId,
              userId: keyRow.userId,
              periodStart: yesterday00Utc.toISOString(),
              periodEnd: today00Utc.toISOString(),
              periodType: "daily",
              triggeredBy: "cron",
              triggeredByUser: null,
              apiKeyId: keyRow.id,
              keyNameSnapshot: keyRow.name,
            });
            keyJobsEnqueued += 1;
          } catch {
            enqueueFailures += 1;
          }
        }
      }
    }
  }

  return {
    orgsConsidered: orgs.length,
    membersEnumerated,
    jobsEnqueued,
    enqueueFailures,
    keyCandidates,
    keyJobsEnqueued,
    keyJobsCapped,
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
  /** PR4: pass-through to `enqueueDailyEvaluatorJobs`. Default: false. */
  enableProjectEvaluation?: boolean;
  /** PR4: pass-through to `enqueueDailyEvaluatorJobs`. Default: 20. */
  maxProjectKeysPerUser?: number;
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
        enableProjectEvaluation: opts.enableProjectEvaluation,
        maxProjectKeysPerUser: opts.maxProjectKeysPerUser,
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
