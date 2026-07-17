/**
 * `runDeliveryQuality` — the LLM quality orchestrator for github-delivery
 * (PR3 Task 5). Samples a member's merged PRs in the report window, asks
 * the facet-eval loopback LLM for a bounded qualitative adjustment +
 * narrative, and ledgers the real spend. Consumed by Task 6, which merges
 * the result into the `github_delivery_reports` row already created by
 * `runDeliveryEval` (this function never writes that table itself).
 *
 * Transient-vs-terminal error split (mirrors facet's extractOne, see
 * facet/extractor.ts and facetLlmClient.ts's header comment):
 *   - TERMINAL (returned as a `DeliveryQualityResult`, job succeeds):
 *     org disabled/no model, budget_denied, no_connection, no_merged_prs,
 *     and parse_error (after the one retry). These are all outcomes the
 *     caller can persist as-is; retrying the whole job would not change
 *     the LLM's inability to produce valid JSON, so parse_error is
 *     terminal too — same as facet's deterministic-error branch.
 *   - TRANSIENT (RETHROWN, job retries via BullMQ): the LLM client throws
 *     — a loopback fetch failure, missing eval key, or non-2xx status
 *     (`createFacetLlmClient`'s throw shape, `Error & {status?: number}`).
 *     These are upstream/infra hiccups, not judgments about the PRs, so
 *     the whole job should retry rather than land a terminal skip.
 *
 * Per-PR GitHub fetch errors are NOT transport errors in the above sense —
 * they drop just that PR (log + continue) so one bad PR doesn't sink the
 * whole report; only an empty sampled set afterward is terminal
 * (no_merged_prs).
 */
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  githubConnections,
  githubPullRequests,
  organizations,
  usageLogs,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";
import {
  buildDeliveryQualityPrompt,
  MAX_REVIEW_COMMENTS,
  parseDeliveryQualityResponse,
  QUALITY_RETRY_SUFFIX,
  samplePullsForQuality,
  truncateDiff,
  type QualityEvidenceItem,
  type QualityPromptPr,
} from "@caliber/evaluator";
import { decryptCredential, safeErrorMessage } from "@caliber/gateway-core";
import type { GatewayMetrics } from "../../plugins/metrics.js";
import { createGithubClient } from "../githubSync/githubClient.js";
import { createFacetLlmClient } from "../evaluator/facetLlmClient.js";
import type { BudgetAlertEvent } from "../evaluator/budgetAlertWebhook.js";
import {
  DELIVERY_ANALYSIS_EVENT_TYPE,
  REF_TYPE_GITHUB_DELIVERY_REPORT,
  deepAnalysisBudgetGate,
  isDeepAnalysisEnforceEnabled,
  writeDeepAnalysisLedger,
  type BudgetGateMetrics,
} from "../evaluator/ledgerDeepAnalysis.js";

/** Mirrors runDeliveryEval.ts's LoggerLike (same no-shared-module precedent). */
export interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** `x-request-id` → usage_logs poll idiom (same constants as runLlm.ts). */
const LLM_COST_LOOKUP_MAX_ATTEMPTS = 3;
const LLM_COST_LOOKUP_DELAY_MS = 250;

const QUALITY_MAX_TOKENS = 4000;

export interface RunDeliveryQualityInput {
  db: Database;
  redis: Redis;
  gatewayBaseUrl: string;
  masterKeyHex: string;
  orgId: string;
  ghUserId: number;
  reportId: string;
  window: { start: Date; end: Date };
  quant: {
    totalScore: number;
    windowDays: number;
    sections: Array<{ key: string; score: number | null }>;
  };
  fetchImpl?: typeof fetch;
  sleepMs?: (ms: number) => Promise<void>;
  logger?: LoggerLike;
  /**
   * Optional — surfaces budget warn/exceeded counters AND ledgers delivery
   * spend against `gwLlmCostUsdTotal` (Task 5, budget metrics/webhook
   * parity for the delivery path). Threaded to both `deepAnalysisBudgetGate`
   * (the pre-call halt check) and `writeDeepAnalysisLedger` (the post-call
   * cost ledger write).
   */
  metrics?: BudgetGateMetrics & Pick<GatewayMetrics, "gwLlmCostUsdTotal">;
  /** Optional sink for budget warn/exceeded webhook alerts (Task 5). */
  onBudgetEvent?: (e: BudgetAlertEvent) => void;
}

export type DeliveryQualityResult =
  | { status: "skipped"; reason: "disabled" | "no_model" | "no_connection" | "no_merged_prs" }
  | { status: "budget_denied" }
  | { status: "parse_error"; model: string }
  | {
      status: "ok";
      qualityAdjustment: number;
      narrative: string;
      evidence: QualityEvidenceItem[];
      model: string;
      calledAt: Date;
      costUsd: number | null;
    };

export async function runDeliveryQuality(
  input: RunDeliveryQualityInput,
): Promise<DeliveryQualityResult> {
  // 1. Org config + budget gate.
  const org = await input.db
    .select({
      llmEvalEnabled: organizations.llmEvalEnabled,
      llmEvalModel: organizations.llmEvalModel,
      llmEvalAccountId: organizations.llmEvalAccountId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1)
    .then((r) => r[0]);

  if (!org?.llmEvalEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!org.llmEvalModel) {
    return { status: "skipped", reason: "no_model" };
  }

  // Shared gate (Task 5): previously a bare `enforceBudget` call here meant a
  // delivery budget denial incremented no counter and fired no webhook — the
  // operator was blind exactly when spend was being refused. Routing through
  // `deepAnalysisBudgetGate` gives the delivery path the same
  // metrics/webhook parity the evaluator's deep-analysis path already has.
  const gate = await deepAnalysisBudgetGate({
    db: input.db,
    orgId: input.orgId,
    enforce: isDeepAnalysisEnforceEnabled(),
    metrics: input.metrics,
    onBudgetEvent: input.onBudgetEvent,
  });
  if (gate.skip) {
    return { status: "budget_denied" };
  }

  // 2. Connection + PAT decrypt.
  const conn = await input.db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.orgId, input.orgId))
    .limit(1)
    .then((r) => r[0]);

  if (!conn) {
    return { status: "skipped", reason: "no_connection" };
  }

  const token = decryptCredential({
    masterKeyHex: input.masterKeyHex,
    accountId: conn.id,
    sealed: { nonce: conn.nonce, ciphertext: conn.ciphertext, authTag: conn.authTag },
  });
  const githubClient = createGithubClient({ token, fetchImpl: input.fetchImpl });

  // 3. Candidate merged PRs in window, authored by ghUserId.
  const candidateRows = await input.db
    .select({
      repoFullName: githubPullRequests.repoFullName,
      number: githubPullRequests.number,
      title: githubPullRequests.title,
      additions: githubPullRequests.additions,
      deletions: githubPullRequests.deletions,
      mergedAt: githubPullRequests.mergedAt,
    })
    .from(githubPullRequests)
    .where(
      and(
        eq(githubPullRequests.orgId, input.orgId),
        eq(githubPullRequests.authorGhId, input.ghUserId),
        isNotNull(githubPullRequests.mergedAt),
        gte(githubPullRequests.mergedAt, input.window.start),
        lte(githubPullRequests.mergedAt, input.window.end),
      ),
    );

  const candidates = candidateRows
    .filter((r): r is typeof r & { mergedAt: Date } => r.mergedAt !== null)
    .map((r) => ({
      repoFullName: r.repoFullName,
      number: r.number,
      title: r.title,
      additions: r.additions,
      deletions: r.deletions,
      mergedAt: r.mergedAt,
    }));

  const sampled = samplePullsForQuality(candidates);
  if (sampled.length === 0) {
    return { status: "skipped", reason: "no_merged_prs" };
  }

  // 4. Per-PR fetch (body + diff + review comments); drop failures, continue.
  const prs: QualityPromptPr[] = [];
  for (const pr of sampled) {
    try {
      const [detail, diff, reviewComments] = await Promise.all([
        githubClient.getPull(pr.repoFullName, pr.number),
        githubClient.getPullDiff(pr.repoFullName, pr.number),
        githubClient.listReviewComments(pr.repoFullName, pr.number),
      ]);
      prs.push({
        repoFullName: pr.repoFullName,
        number: pr.number,
        title: pr.title,
        body: detail.body ?? null,
        diff: truncateDiff(diff),
        reviewComments: reviewComments.slice(0, MAX_REVIEW_COMMENTS).map((c) => c.body),
      });
    } catch (err) {
      input.logger?.warn(
        {
          err: safeErrorMessage(err),
          orgId: input.orgId,
          repoFullName: pr.repoFullName,
          number: pr.number,
        },
        "github-delivery quality: per-PR fetch failed, dropping PR",
      );
    }
  }

  if (prs.length === 0) {
    return { status: "skipped", reason: "no_merged_prs" };
  }

  // 5. Build prompt + call the loopback LLM (one retry on parse failure).
  const prompt = buildDeliveryQualityPrompt({
    windowDays: input.quant.windowDays,
    quantTotal: input.quant.totalScore,
    sectionSummary: input.quant.sections,
    prs,
  });

  const llmClient = createFacetLlmClient({
    redis: input.redis,
    gatewayBaseUrl: input.gatewayBaseUrl,
    orgId: input.orgId,
    evalAccountId: org.llmEvalAccountId,
    fetchImpl: input.fetchImpl,
  });

  // Transport errors (fetch failure / missing key / non-2xx) are NOT caught
  // here — they propagate up so the whole job retries via BullMQ (see file
  // header). Only parse failures are handled locally (terminal, with retry).
  const sleep = input.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const first = await llmClient.call({
    model: org.llmEvalModel,
    system: prompt.system,
    user: prompt.user,
    maxTokens: QUALITY_MAX_TOKENS,
  });

  let parsed = parseDeliveryQualityResponse(first.text);
  // Ledger the first call's spend right away, before a retry's requestId
  // can overwrite it. Every call that actually happened cost real money —
  // ledgering only the LAST call (or, on terminal parse_error, ledgering
  // nothing) is the "money spent, ledger blind" defect task 4 exists to
  // close (I4). Best-effort per call, same as before: a ledger failure logs
  // and is swallowed, it never fails the report.
  let costUsd = await ledgerQualityCall({
    db: input.db,
    orgId: input.orgId,
    reportId: input.reportId,
    requestId: first.requestId,
    metrics: input.metrics,
    logger: input.logger,
    sleep,
  });

  if (!parsed.ok) {
    const retry = await llmClient.call({
      model: org.llmEvalModel,
      system: prompt.system,
      user: prompt.user + QUALITY_RETRY_SUFFIX,
      maxTokens: QUALITY_MAX_TOKENS,
    });
    parsed = parseDeliveryQualityResponse(retry.text);
    const retryCostUsd = await ledgerQualityCall({
      db: input.db,
      orgId: input.orgId,
      reportId: input.reportId,
      requestId: retry.requestId,
      metrics: input.metrics,
      logger: input.logger,
      sleep,
    });
    // Design decision (I4): the report's costUsd is the SUM of every call
    // this run actually made, not just the last one. The ledger already
    // sums correctly per-row (that's the budget-enforcement fix); the
    // report-facing figure exists to answer "what did producing this
    // report cost", and understating it to one call's cost when two were
    // spent would reopen the same honesty gap for the displayed number
    // that task 4 closed for the ledger. `null` only when NEITHER call's
    // cost could be recovered (no request id, or usage_logs never
    // materialized) — not when just one of the two comes up empty.
    costUsd = costUsd === null && retryCostUsd === null
      ? null
      : (costUsd ?? 0) + (retryCostUsd ?? 0);
  }

  if (!parsed.ok) {
    return { status: "parse_error", model: org.llmEvalModel };
  }

  return {
    status: "ok",
    qualityAdjustment: parsed.qualityAdjustment,
    narrative: parsed.narrative,
    evidence: parsed.evidence,
    model: org.llmEvalModel,
    calledAt: new Date(),
    costUsd,
  };
}

/**
 * Best-effort ledger write for ONE loopback call (I4). Polls usage_logs for
 * the call's real cost (own poll, independent of the ledger's internal
 * poll), then writes the ledger row; a write failure logs and is swallowed
 * — never throws, so it can be called for every call that happened
 * (including on the terminal parse_error path) without risking the job.
 * `requestId` may be absent (defensive — the loopback client's shape
 * guarantees one today) or shared between two calls' rows courtesy of
 * `writeDeepAnalysisLedger`'s dedup-on-`usage_log_request_id` (migration
 * 0033): a real first+retry pair always carries two distinct request ids,
 * so both ledger.
 */
async function ledgerQualityCall(params: {
  db: Database;
  orgId: string;
  reportId: string;
  requestId: string | undefined;
  metrics: RunDeliveryQualityInput["metrics"];
  logger: LoggerLike | undefined;
  sleep: (ms: number) => Promise<void>;
}): Promise<number | null> {
  if (!params.requestId) return null;

  const costUsd = await pollUsageLogCost(params.db, params.requestId, params.sleep);

  try {
    await writeDeepAnalysisLedger({
      db: params.db,
      orgId: params.orgId,
      reportId: params.reportId,
      refType: REF_TYPE_GITHUB_DELIVERY_REPORT,
      eventType: DELIVERY_ANALYSIS_EVENT_TYPE,
      usageLogRequestId: params.requestId,
      metrics: params.metrics,
      sleepMs: params.sleep,
    });
  } catch (err) {
    params.logger?.warn(
      { err: safeErrorMessage(err), orgId: params.orgId, reportId: params.reportId },
      "github-delivery quality: ledger write failed",
    );
  }

  return costUsd;
}

async function pollUsageLogCost(
  db: Database,
  requestId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<number | null> {
  for (let i = 0; i < LLM_COST_LOOKUP_MAX_ATTEMPTS; i++) {
    const row = await db
      .select({ totalCost: usageLogs.totalCost })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, requestId))
      .limit(1)
      .then((r) => r[0]);
    if (row) {
      return Number(row.totalCost);
    }
    if (i < LLM_COST_LOOKUP_MAX_ATTEMPTS - 1) {
      await sleep(LLM_COST_LOOKUP_DELAY_MS);
    }
  }
  return null;
}
