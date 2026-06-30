/**
 * Rule-based evaluator worker logic (Plan 4B Part 4, Task 4.2).
 *
 * Exports two functions:
 *   - `runRuleBased`           — fetches, decrypts, and scores data; NO DB write.
 *   - `upsertEvaluationReport` — persists a report (with optional LLM columns).
 *
 * The split enables `runEvaluation` (Task 5.3) to merge LLM results before the
 * DB write, and enables the dry-run endpoint (Part 6) to call the scorer without
 * persisting anything.
 */

import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  evaluationReports,
  requestBodies,
  requestBodyFacets,
  usageLogs,
} from "@caliber/db";
import { decryptBody } from "../../capture/encrypt.js";
import {
  scoreWithRules,
  type BodyRow,
  type Report,
  type Rubric,
  type UsageRow,
} from "@caliber/evaluator";

// ── RunRuleBased input / output ───────────────────────────────────────────────

export interface RunRuleBasedInput {
  db: Database;
  masterKeyHex: string;
  orgId: string;
  userId: string;
  /**
   * When set, scopes the usage_logs fetch (and transitively the request_bodies /
   * request_body_facets fetch) to this api_key only.  When absent, all of the
   * user's requests in the period window are included (per-person path).
   */
  apiKeyId?: string;
  periodStart: Date;
  periodEnd: Date;
  rubric: Rubric;
  /** Optional: pre-computed set of truncated request IDs (for testing). */
  truncatedRequestIds?: Set<string>;
}

export interface RunRuleBasedResult {
  report: Report;
  /** true when the evaluation window contained no usage rows. */
  skipped: boolean;
  /** Decrypted body rows — needed by runLlmDeepAnalysis. */
  bodies: BodyRow[];
}

// ── UpsertEvaluationReport input ─────────────────────────────────────────────

export interface UpsertEvaluationReportInput {
  db: Database;
  orgId: string;
  userId: string;
  teamId?: string | null;
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

// ── runRuleBased ─────────────────────────────────────────────────────────────

/**
 * Fetch usage logs and request bodies for the given user/period, decrypt body
 * blobs, and score the data via the rule engine.
 *
 * Does NOT write anything to the database — call `upsertEvaluationReport`
 * afterwards (typically via `runEvaluation`).
 *
 * Returns `{ skipped: true }` when the window contains no usage rows.
 */
export async function runRuleBased(
  input: RunRuleBasedInput,
): Promise<RunRuleBasedResult> {
  const { db, masterKeyHex, userId, periodStart, periodEnd } = input;

  // 1. Fetch usage_logs in window.
  // When apiKeyId is provided (per-key grain), append an extra eq() predicate so
  // only logs produced by that key are fetched.  Body/facet scoping follows
  // transitively because both queries use inArray(requestId, requestIds) derived
  // from this filtered usage set — no other changes needed.
  const usageRowsRaw = await db
    .select()
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, periodStart),
        lt(usageLogs.createdAt, periodEnd),
        input.apiKeyId
          ? eq(usageLogs.apiKeyId, input.apiKeyId)
          : undefined,
      ),
    );

  if (usageRowsRaw.length === 0) {
    return {
      report: {
        totalScore: 0,
        sectionScores: [],
        signalsSummary: {
          requests: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost: 0,
          cache_read_ratio: 0,
          refusal_rate: 0,
          model_mix: {},
          client_mix: {},
          model_diversity: 0,
          tool_diversity: 0,
          iteration_count: 0,
          client_mix_ratio: 0,
          body_capture_coverage: 0,
          period: { requestCount: 0, bodyCount: 0 },
        },
        dataQuality: {
          capturedRequests: 0,
          missingBodies: 0,
          truncatedBodies: 0,
          totalRequests: 0,
          coverageRatio: 0,
        },
      },
      skipped: true,
      bodies: [],
    };
  }

  const requestIds = usageRowsRaw.map((r) => r.requestId);

  // 2. Fetch request_bodies for those request IDs
  const bodyRowsRaw =
    requestIds.length === 0
      ? []
      : await db
          .select()
          .from(requestBodies)
          .where(inArray(requestBodies.requestId, requestIds));

  // 3. Decrypt body blobs — failures treated as empty body (graceful degradation)
  const bodyRows: BodyRow[] = bodyRowsRaw.map((b) => {
    const requestBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.requestBodySealed,
    );
    const responseBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.responseBodySealed,
    );

    return {
      requestId: b.requestId,
      stopReason: b.stopReason ?? null,
      clientUserAgent: b.clientUserAgent ?? null,
      clientSessionId: b.clientSessionId ?? null,
      requestParams: b.requestParams ?? null,
      responseBody: tryParse(responseBodyStr),
      requestBody: tryParse(requestBodyStr),
    };
  });

  // 4. Normalize usage rows to the shape scoreWithRules expects
  const usageRows: UsageRow[] = usageRowsRaw.map((u) => ({
    requestId: u.requestId,
    requestedModel: u.requestedModel,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    totalCost: u.totalCost,
  }));

  const truncatedRequestIds =
    input.truncatedRequestIds ??
    new Set(bodyRowsRaw.filter((b) => b.bodyTruncated).map((b) => b.requestId));

  // 4b. Plan 4C — load facet rows for the same window so any `facet_*`
  //     signal in the rubric has data to aggregate. Empty when facet
  //     extraction is disabled / no rows extracted; the rule engine
  //     handles the empty case (gte aggregators → hit:false; lte → true).
  const facetRowsRaw =
    requestIds.length === 0
      ? []
      : await db
          .select({
            sessionType: requestBodyFacets.sessionType,
            outcome: requestBodyFacets.outcome,
            claudeHelpfulness: requestBodyFacets.claudeHelpfulness,
            frictionCount: requestBodyFacets.frictionCount,
            bugsCaughtCount: requestBodyFacets.bugsCaughtCount,
            codexErrorsCount: requestBodyFacets.codexErrorsCount,
          })
          .from(requestBodyFacets)
          .where(inArray(requestBodyFacets.requestId, requestIds));

  // 5. Score with rules
  const report = scoreWithRules({
    rubric: input.rubric,
    usageRows,
    bodyRows,
    truncatedRequestIds,
    facetRows: facetRowsRaw,
  });

  return { report, skipped: false, bodies: bodyRows };
}

// ── upsertEvaluationReport ───────────────────────────────────────────────────

/**
 * Upsert an evaluation_reports row.
 *
 * Handles both:
 *   - rule-based-only (llm: null) → LLM columns left NULL
 *   - with LLM results (llm: {...}) → LLM columns populated
 *
 * Returns the inserted/updated row ID, or null if nothing came back.
 */
export async function upsertEvaluationReport(
  input: UpsertEvaluationReportInput,
): Promise<string | null> {
  const base = {
    orgId: input.orgId,
    userId: input.userId,
    teamId: input.teamId ?? null,
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
    .insert(evaluationReports)
    .values(withLlm)
    .onConflictDoUpdate({
      target: [
        evaluationReports.userId,
        evaluationReports.periodStart,
        evaluationReports.periodType,
      ],
      set: {
        ...withLlm,
        updatedAt: new Date(),
      },
    })
    .returning({ id: evaluationReports.id });

  return inserted[0]?.id ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a sealed body blob. Returns empty string on any failure so a single
 * corrupted blob does not fail the entire evaluation report.
 */
function safeDecrypt(
  masterKeyHex: string,
  requestId: string,
  sealed: Buffer,
): string {
  try {
    return decryptBody({ masterKeyHex, requestId, sealed });
  } catch {
    return "";
  }
}

/**
 * Try to parse a string as JSON. Returns the raw string on failure so callers
 * always get a usable value.
 */
function tryParse(s: string): unknown {
  if (s === "") return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
