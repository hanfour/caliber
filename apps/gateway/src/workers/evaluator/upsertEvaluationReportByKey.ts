/**
 * Upsert helper for `evaluation_reports_by_key` (PR3).
 *
 * Mirrors `upsertEvaluationReport` from `runRuleBased.ts` in structure but
 * writes to the separate `evaluation_reports_by_key` table.  The two key
 * differences from the per-person upsert:
 *
 *   1. Two extra required columns: `apiKeyId` + `keyNameSnapshot` (persists the
 *      key's name at evaluation time so historical reports survive a rename or
 *      revoke).
 *   2. `teamId` is sourced from the api_keys row (passed in by the caller;
 *      `runEvaluation` looks it up when `apiKeyId` is present).  For per-person
 *      the caller writes NULL — for per-key the caller writes the key's
 *      `team_id` so per-key team roll-ups work.
 *   3. `onConflict` targets the 4-tuple unique index
 *      `(userId, apiKeyId, periodStart, periodType)` instead of the per-person
 *      3-tuple `(userId, periodStart, periodType)`.
 *
 * The scoring column shape (rubric, scores, LLM columns, triggered_by, etc.) is
 * identical to the per-person variant — both tables share `evaluationReportScoreColumns()`.
 */

import type { Database } from "@caliber/db";
import { evaluationReportsByKey } from "@caliber/db";
import type { Report } from "@caliber/evaluator";

// ── Input type ────────────────────────────────────────────────────────────────

export interface UpsertEvaluationReportByKeyInput {
  db: Database;
  orgId: string;
  userId: string;
  /**
   * Sourced from `api_keys.team_id` at the time of evaluation.  May be null if
   * the key has no team assignment.
   */
  teamId?: string | null;
  /** The api_key being evaluated. */
  apiKeyId: string;
  /**
   * Snapshot of `api_keys.name` at evaluation time.  Preserved in the row so
   * the report label survives future key renames or revocations.
   */
  keyNameSnapshot: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: "daily" | "weekly" | "monthly";
  rubricId: string;
  rubricVersion: string;
  triggeredBy: "cron" | "admin_rerun" | "manual";
  triggeredByUser: string | null;
  report: Report;
  llm: {
    narrative: string;
    evidence: unknown;
    model: string;
    calledAt: Date;
    costUsd: number;
    upstreamAccountId: string | null;
  } | null;
}

// ── Upsert function ──────────────────────────────────────────────────────────

/**
 * Upsert an `evaluation_reports_by_key` row.
 *
 * Idempotent via `onConflictDoUpdate` targeting the 4-tuple unique index
 * `(userId, apiKeyId, periodStart, periodType)`.  A re-run of the same key +
 * period updates the existing row (same semantics as the per-person upsert).
 *
 * Returns the inserted/updated row ID, or null if nothing came back.
 */
export async function upsertEvaluationReportByKey(
  input: UpsertEvaluationReportByKeyInput,
): Promise<string | null> {
  const base = {
    orgId: input.orgId,
    userId: input.userId,
    teamId: input.teamId ?? null,
    apiKeyId: input.apiKeyId,
    keyNameSnapshot: input.keyNameSnapshot,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodType: input.periodType,
    rubricId: input.rubricId,
    rubricVersion: input.rubricVersion,
    totalScore: String(input.report.totalScore),
    // jsonb columns — cast to unknown to satisfy Drizzle's strict typing
    sectionScores: input.report.sectionScores as unknown,
    signalsSummary: input.report.signalsSummary as unknown,
    dataQuality: input.report.dataQuality as unknown,
    triggeredBy: input.triggeredBy,
    triggeredByUser: input.triggeredByUser,
  };

  const withLlm = input.llm
    ? {
        ...base,
        llmNarrative: input.llm.narrative,
        llmEvidence: input.llm.evidence as unknown,
        llmModel: input.llm.model,
        llmCalledAt: input.llm.calledAt,
        llmCostUsd: String(input.llm.costUsd),
        llmUpstreamAccountId: input.llm.upstreamAccountId,
      }
    : base;

  const inserted = await input.db
    .insert(evaluationReportsByKey)
    .values(withLlm)
    .onConflictDoUpdate({
      // 4-tuple unique index: (userId, apiKeyId, periodStart, periodType)
      target: [
        evaluationReportsByKey.userId,
        evaluationReportsByKey.apiKeyId,
        evaluationReportsByKey.periodStart,
        evaluationReportsByKey.periodType,
      ],
      set: {
        ...withLlm,
        updatedAt: new Date(),
      },
    })
    .returning({ id: evaluationReportsByKey.id });

  return inserted[0]?.id ?? null;
}
