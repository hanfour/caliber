/**
 * Evaluation orchestrator (Plan 4B Part 5, Task 5.3).
 *
 * Combines rule-based scoring (Task 4.2) with optional LLM deep analysis
 * (Task 5.2) into a single entry point. The worker calls this function
 * instead of `runRuleBased` directly.
 *
 * Flow:
 *   1. Run rule-based → get Report + bodies (no DB write).
 *   2. If org has llmEvalEnabled=true AND coverageRatio >= 0.5 → run LLM.
 *   3. Upsert report into evaluation_reports (with or without LLM columns).
 *   4. If LLM fails → proceed with rule-based only; LLM columns stay NULL.
 */

import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import type { Rubric } from "@caliber/evaluator";
import type { BudgetAlertEvent } from "./budgetAlertWebhook.js";
import {
  runRuleBased,
  upsertEvaluationReport,
  type UpsertEvaluationReportInput,
} from "./runRuleBased.js";
import { runLlmDeepAnalysis, type LlmMetrics } from "./runLlm.js";
import {
  runFacetExtraction,
  type FacetMetrics,
  type RunFacetExtractionResult,
} from "./runFacetExtraction.js";
import {
  deepAnalysisBudgetGate,
  writeDeepAnalysisLedger,
  isDeepAnalysisEnforceEnabled,
  REF_TYPE_PERSON,
} from "./ledgerDeepAnalysis.js";
import type { GatewayMetrics } from "../../plugins/metrics.js";

/**
 * Deep-analysis grain for this PR. Only the per-person grain exists today; the
 * per-key grain (`"key"` + `REF_TYPE_KEY`) is wired in PR3. The metric label and
 * the ledger `refType` are both pinned here so PR3 has one place to branch.
 */
const DEEP_ANALYSIS_GRAIN_PERSON = "person";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum body coverage ratio required to run LLM deep analysis.
 * Below this threshold the LLM cannot meaningfully cite evidence.
 * (Design spec §4.2)
 */
export const LLM_MIN_COVERAGE_RATIO = 0.5;

// ── Input / Output types ─────────────────────────────────────────────────────

export interface EvaluationMetrics extends LlmMetrics, Partial<FacetMetrics> {
  gwEvalLlmCalledTotal?: {
    inc: (labels: { result: string; grain: string }) => void;
  };
  gwEvalLlmCostUsd?: { inc: (labels: { grain: string }, value: number) => void };
  gwEvalDlqCount?: { inc: () => void };
}

export interface RunEvaluationInput {
  db: Database;
  redis: Redis;
  masterKeyHex: string;
  gatewayBaseUrl: string;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: "daily" | "weekly" | "monthly";
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  triggeredBy: "cron" | "admin_rerun" | "manual";
  triggeredByUser: string | null;
  /** Read from org row by caller; passed in explicitly to avoid a redundant DB round-trip. */
  llmEvalEnabled: boolean;
  /** For test injection — overrides global fetch. */
  fetchImpl?: typeof fetch;
  /** For test injection — overrides sleep delays in LLM cost lookup. */
  sleepMs?: (ms: number) => Promise<void>;
  /** For metric emission (test injection). */
  metrics?: EvaluationMetrics;
  /** Optional sink for budget warn/exceeded webhook alerts (Plan P4). */
  onBudgetEvent?: (e: BudgetAlertEvent) => void;
}

export interface RunEvaluationResult {
  reportId: string | null;
  totalScore: number;
  skipped: boolean;
  llmAttempted: boolean;
  llmSucceeded: boolean;
  llmCostUsd: number;
  /** Outcome of the optional facet-extraction pass (Plan 4C follow-up #1). */
  facetResult?: RunFacetExtractionResult;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runEvaluation(
  input: RunEvaluationInput,
): Promise<RunEvaluationResult> {
  // Phase 1: rule-based scoring (no DB write)
  const rb = await runRuleBased({
    db: input.db,
    masterKeyHex: input.masterKeyHex,
    orgId: input.orgId,
    userId: input.userId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    rubric: input.rubric,
  });

  if (rb.skipped) {
    return {
      reportId: null,
      totalScore: 0,
      skipped: true,
      llmAttempted: false,
      llmSucceeded: false,
      llmCostUsd: 0,
    };
  }

  // Phase 1.5: optional facet enrichment (Plan 4C follow-up #1).
  // Runs after rule-based scoring but before deep analysis. Fail-soft —
  // never blocks the rest of the pipeline. Gated by ENABLE_FACET_EXTRACTION
  // (process env) AND per-org `llm_facet_enabled`.
  let facetResult: RunFacetExtractionResult | undefined;
  if (process.env.ENABLE_FACET_EXTRACTION === "true") {
    try {
      facetResult = await runFacetExtraction({
        db: input.db,
        redis: input.redis,
        gatewayBaseUrl: input.gatewayBaseUrl,
        orgId: input.orgId,
        bodies: rb.bodies,
        fetchImpl: input.fetchImpl,
        metrics: extractFacetMetrics(input.metrics),
        onBudgetEvent: input.onBudgetEvent,
      });
    } catch {
      // runFacetExtraction is itself fail-soft; this is belt-and-suspenders.
      facetResult = {
        attempted: 0,
        extracted: 0,
        cacheHits: 0,
        skippedReason: "extraction_error",
      };
    }
  }

  // Phase 2: optional LLM deep analysis
  // Gate: org opted in AND we have enough body coverage to cite evidence.
  const shouldRunLlm =
    input.llmEvalEnabled &&
    rb.report.dataQuality.coverageRatio >= LLM_MIN_COVERAGE_RATIO;

  let llmResult: Awaited<ReturnType<typeof runLlmDeepAnalysis>> = null;

  if (shouldRunLlm) {
    // PR2 — pre-call budget halt gate. Deep-analysis cost is only known
    // post-call, so this is a halt-state check (skip if ALREADY over budget),
    // not a pre-charge. The kill-switch EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS
    // (default on) disables only THIS enforcement — the post-upsert ledger
    // write below is unconditional (honest accounting, spec §6).
    const gate = await deepAnalysisBudgetGate({
      db: input.db,
      orgId: input.orgId,
      enforce: isDeepAnalysisEnforceEnabled(),
      metrics: extractBudgetMetrics(input.metrics),
      onBudgetEvent: input.onBudgetEvent,
    });

    if (gate.skip) {
      // Over budget → fall back to rule-based (llmResult stays null).
      input.metrics?.gwEvalLlmCalledTotal?.inc({
        result: "skipped_budget",
        grain: DEEP_ANALYSIS_GRAIN_PERSON,
      });
    } else {
      llmResult = await runLlmDeepAnalysis({
        db: input.db,
        redis: input.redis,
        gatewayBaseUrl: input.gatewayBaseUrl,
        orgId: input.orgId,
        rubric: input.rubric,
        ruleBasedReport: rb.report,
        bodies: rb.bodies,
        fetchImpl: input.fetchImpl,
        sleepMs: input.sleepMs,
        metrics: input.metrics,
      });

      if (llmResult !== null) {
        input.metrics?.gwEvalLlmCalledTotal?.inc({
          result: "success",
          grain: DEEP_ANALYSIS_GRAIN_PERSON,
        });
        input.metrics?.gwEvalLlmCostUsd?.inc(
          { grain: DEEP_ANALYSIS_GRAIN_PERSON },
          llmResult.costUsd,
        );
      } else {
        input.metrics?.gwEvalLlmCalledTotal?.inc({
          result: "fetch_failed",
          grain: DEEP_ANALYSIS_GRAIN_PERSON,
        });
      }
    }
  } else if (input.llmEvalEnabled) {
    // Skipped due to low coverage (llmEvalEnabled is true, but coverage < 0.5)
    input.metrics?.gwEvalLlmCalledTotal?.inc({
      result: "skipped_low_coverage",
      grain: DEEP_ANALYSIS_GRAIN_PERSON,
    });
  }

  // Phase 3: upsert — always runs (even when LLM failed; llm columns stay NULL)
  const upsertInput: UpsertEvaluationReportInput = {
    db: input.db,
    orgId: input.orgId,
    userId: input.userId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodType: input.periodType,
    rubricId: input.rubricId,
    rubricVersion: input.rubricVersion,
    triggeredBy: input.triggeredBy,
    triggeredByUser: input.triggeredByUser,
    report: rb.report,
    llm: llmResult
      ? {
          narrative: llmResult.narrative,
          evidence: llmResult.evidence,
          model: llmResult.model,
          calledAt: new Date(),
          costUsd: llmResult.costUsd,
          upstreamAccountId: llmResult.upstreamAccountId,
        }
      : null,
  };

  const reportId = await upsertEvaluationReport(upsertInput);

  // Phase 3.5 (PR2): ledger the deep-analysis spend — AFTER the upsert so
  // `reportId` exists as the `ref_id`. Written UNCONDITIONALLY on LLM success
  // (honest accounting, independent of the budget kill-switch). Idempotent via
  // `onConflictDoNothing` on `llm_usage_dedup_idx` so a BullMQ retry that
  // re-runs the job cannot double-count this report's deep-analysis cost.
  // Not wrapped in try/catch: a transient DB error must surface (so spend is
  // never silently lost) — the dedup index keeps the retry single-counted.
  if (llmResult !== null && reportId !== null) {
    await writeDeepAnalysisLedger({
      db: input.db,
      orgId: input.orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: llmResult.requestId,
      metrics: input.metrics?.gwLlmCostUsdTotal
        ? { gwLlmCostUsdTotal: input.metrics.gwLlmCostUsdTotal }
        : undefined,
      sleepMs: input.sleepMs,
    });
  }

  return {
    reportId,
    totalScore: rb.report.totalScore,
    skipped: false,
    llmAttempted: shouldRunLlm,
    llmSucceeded: llmResult !== null,
    llmCostUsd: llmResult?.costUsd ?? 0,
    facetResult,
  };
}

/**
 * Pull just the two budget counters the deep-analysis gate needs from the
 * broader `EvaluationMetrics` bag. Returns undefined if either is absent so the
 * gate falls back to its no-metrics (pure `enforceBudget`) path.
 */
function extractBudgetMetrics(
  m: EvaluationMetrics | undefined,
):
  | Pick<GatewayMetrics, "gwLlmBudgetWarnTotal" | "gwLlmBudgetExceededTotal">
  | undefined {
  if (!m?.gwLlmBudgetWarnTotal || !m.gwLlmBudgetExceededTotal) {
    return undefined;
  }
  return {
    gwLlmBudgetWarnTotal: m.gwLlmBudgetWarnTotal,
    gwLlmBudgetExceededTotal: m.gwLlmBudgetExceededTotal,
  };
}

/**
 * Pull just the metrics that `runFacetExtraction` needs from the broader
 * `EvaluationMetrics` bag. Returns undefined if none of the facet metrics
 * are present so the orchestrator can fall back to its no-metrics path.
 */
function extractFacetMetrics(
  m: EvaluationMetrics | undefined,
): FacetMetrics | undefined {
  if (
    !m?.gwLlmCostUsdTotal ||
    !m.gwLlmBudgetWarnTotal ||
    !m.gwLlmBudgetExceededTotal ||
    !m.gwFacetExtractTotal ||
    !m.gwFacetExtractDurationMs ||
    !m.gwFacetCacheHitTotal
  ) {
    return undefined;
  }
  return {
    gwLlmCostUsdTotal: m.gwLlmCostUsdTotal,
    gwLlmBudgetWarnTotal: m.gwLlmBudgetWarnTotal,
    gwLlmBudgetExceededTotal: m.gwLlmBudgetExceededTotal,
    gwFacetExtractTotal: m.gwFacetExtractTotal,
    gwFacetExtractDurationMs: m.gwFacetExtractDurationMs,
    gwFacetCacheHitTotal: m.gwFacetCacheHitTotal,
  };
}
