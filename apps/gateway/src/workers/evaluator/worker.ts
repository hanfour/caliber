/**
 * BullMQ evaluator worker factory (Plan 4B Part 4, Task 4.2).
 *
 * Consumes `evaluator` queue jobs. Each job fetches usage data for the given
 * user/period, scores it via the rule engine (+ optional LLM deep analysis),
 * and upserts an evaluation_report.
 *
 * Concurrency is kept at 2 (not 4 like body capture) because evaluator jobs
 * are CPU and DB heavy — fetch + decrypt + aggregate.
 */

import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations } from "@caliber/db";
import {
  EVALUATOR_QUEUE_NAME,
  EVALUATOR_QUEUE_PREFIX,
  EvaluatorJobPayload,
} from "./queue.js";
import { runEvaluation, type EvaluationMetrics } from "./runEvaluation.js";
import { createRubricResolver } from "./rubricResolver.js";
import type { BudgetAlertEvent } from "./budgetAlertWebhook.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateEvaluatorWorkerOptions {
  connection: Redis;
  db: Database;
  redis: Redis;
  masterKeyHex: string;
  gatewayBaseUrl: string;
  concurrency?: number;
  metrics?: EvaluationMetrics;
  /** Optional sink for budget warn/exceeded webhook alerts (Plan P4). */
  onBudgetEvent?: (e: BudgetAlertEvent) => void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a BullMQ Worker wired to the `caliber:gw:evaluator` queue.
 *
 * The worker validates the job payload via Zod, resolves the appropriate rubric
 * for the org (custom or platform-default), reads the org's llm_eval_enabled
 * flag, then delegates to `runEvaluation` which combines rule-based scoring
 * with optional LLM deep analysis.
 *
 * The rubric resolver is created once at the factory level so cache persists
 * across jobs.
 */
export function createEvaluatorWorker(
  opts: CreateEvaluatorWorkerOptions,
): Worker<EvaluatorJobPayload, void> {
  // Create resolver ONCE at factory level so cache persists across jobs
  const resolver = createRubricResolver();

  const worker = new Worker<EvaluatorJobPayload, void>(
    EVALUATOR_QUEUE_NAME,
    async (job) => {
      const payload = EvaluatorJobPayload.parse(job.data);

      // Resolve rubric: key-scoped → org custom → platform-default by locale
      const resolved = await resolver.resolve({
        db: opts.db,
        orgId: payload.orgId,
        apiKeyId: payload.apiKeyId, // undefined for per-person jobs → skips key branch → byte-identical
      });

      // Fetch org's llm_eval_enabled flag
      const org = await opts.db
        .select({ llmEvalEnabled: organizations.llmEvalEnabled })
        .from(organizations)
        .where(eq(organizations.id, payload.orgId))
        .limit(1)
        .then((r) => r[0]);

      await runEvaluation({
        db: opts.db,
        redis: opts.redis,
        masterKeyHex: opts.masterKeyHex,
        gatewayBaseUrl: opts.gatewayBaseUrl,
        orgId: payload.orgId,
        userId: payload.userId,
        periodStart: new Date(payload.periodStart),
        periodEnd: new Date(payload.periodEnd),
        periodType: payload.periodType,
        rubric: resolved.rubric,
        rubricId: resolved.rubricId,
        rubricVersion: resolved.rubricVersion,
        triggeredBy: payload.triggeredBy,
        triggeredByUser: payload.triggeredByUser,
        llmEvalEnabled: org?.llmEvalEnabled ?? false,
        metrics: opts.metrics,
        onBudgetEvent: opts.onBudgetEvent,
        // PR3: per-key grain fields (absent → per-person path, byte-identical)
        apiKeyId: payload.apiKeyId,
        keyNameSnapshot: payload.keyNameSnapshot,
      });
    },
    {
      connection: opts.connection,
      prefix: EVALUATOR_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 2,
    } satisfies WorkerOptions,
  );

  // Handle DLQ: track jobs that have exhausted all retries
  worker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      opts.metrics?.gwEvalDlqCount?.inc?.();
    }
  });

  return worker;
}
