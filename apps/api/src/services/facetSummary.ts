import { and, eq, gte, lte } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { requestBodyFacets, usageLogs } from "@caliber/db";

/**
 * Aggregate facet stats for one (org, user, period) window.
 *
 * Joins `request_body_facets` to `usage_logs` (via request_id) so we can
 * filter by the report subject (user_id) and the report window (created_at).
 *
 * Returns the same kind of summary the rule-engine signals consume, plus
 * raw counters useful for the report-page drill-down (Plan 4C follow-up #3).
 *
 * Null behaviour: facet rows with `extraction_error !== null` carry null
 * payload fields — they self-exclude from each aggregation. A field is
 * `null` in the result only when no row in the window had a non-null
 * value for it; the UI renders that as "no data".
 */

export interface FacetSummary {
  /** Total facet rows in the window (incl. extraction errors). */
  total: number;
  /** Rows where extraction succeeded (extractionError IS NULL). */
  succeeded: number;
  /** Rows where extraction failed (extractionError IS NOT NULL). */
  failed: number;
  /** Mean of `claude_helpfulness`, 1-5; null when no row had a value. */
  avgClaudeHelpfulness: number | null;
  /** Sum of `friction_count` across rows that had a value. */
  totalFrictionCount: number | null;
  /** Sum of `bugs_caught_count` across rows that had a value. */
  totalBugsCaught: number | null;
  /** Sum of `codex_errors_count` across rows that had a value. */
  totalCodexErrors: number | null;
  /** Distribution of `session_type` (counts), excluding null rows. */
  sessionTypeCounts: Record<string, number>;
  /** Ratio of success|partial outcomes / non-null outcomes; null when none. */
  outcomeSuccessRate: number | null;
}

const EMPTY_SUMMARY: FacetSummary = {
  total: 0,
  succeeded: 0,
  failed: 0,
  avgClaudeHelpfulness: null,
  totalFrictionCount: null,
  totalBugsCaught: null,
  totalCodexErrors: null,
  sessionTypeCounts: {},
  outcomeSuccessRate: null,
};

export async function getFacetSummary(
  db: Database,
  orgId: string,
  userId: string,
  windowFrom: Date,
  windowTo: Date,
): Promise<FacetSummary> {
  // Join facet → usage_logs to filter by user_id + ts.
  const rows = await db
    .select({
      sessionType: requestBodyFacets.sessionType,
      outcome: requestBodyFacets.outcome,
      claudeHelpfulness: requestBodyFacets.claudeHelpfulness,
      frictionCount: requestBodyFacets.frictionCount,
      bugsCaughtCount: requestBodyFacets.bugsCaughtCount,
      codexErrorsCount: requestBodyFacets.codexErrorsCount,
      extractionError: requestBodyFacets.extractionError,
    })
    .from(requestBodyFacets)
    .innerJoin(usageLogs, eq(requestBodyFacets.requestId, usageLogs.requestId))
    .where(
      and(
        eq(requestBodyFacets.orgId, orgId),
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, windowFrom),
        lte(usageLogs.createdAt, windowTo),
      ),
    );

  if (rows.length === 0) return EMPTY_SUMMARY;

  let succeeded = 0;
  let failed = 0;

  const helpfulnessVals: number[] = [];
  const frictionVals: number[] = [];
  const bugsVals: number[] = [];
  const codexVals: number[] = [];
  const outcomes: string[] = [];
  const sessionTypeCounts: Record<string, number> = {};

  for (const r of rows) {
    if (r.extractionError === null) succeeded++;
    else failed++;

    if (r.claudeHelpfulness != null) helpfulnessVals.push(r.claudeHelpfulness);
    if (r.frictionCount != null) frictionVals.push(r.frictionCount);
    if (r.bugsCaughtCount != null) bugsVals.push(r.bugsCaughtCount);
    if (r.codexErrorsCount != null) codexVals.push(r.codexErrorsCount);

    if (r.outcome != null) outcomes.push(r.outcome);
    if (r.sessionType != null) {
      sessionTypeCounts[r.sessionType] =
        (sessionTypeCounts[r.sessionType] ?? 0) + 1;
    }
  }

  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const sumOrNull = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);

  const outcomeSuccessRate =
    outcomes.length === 0
      ? null
      : outcomes.filter((o) => o === "success" || o === "partial").length /
        outcomes.length;

  return {
    total: rows.length,
    succeeded,
    failed,
    avgClaudeHelpfulness: mean(helpfulnessVals),
    totalFrictionCount: sumOrNull(frictionVals),
    totalBugsCaught: sumOrNull(bugsVals),
    totalCodexErrors: sumOrNull(codexVals),
    sessionTypeCounts,
    outcomeSuccessRate,
  };
}
