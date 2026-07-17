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
  enforceBudget,
  isBudgetError,
  MAX_REVIEW_COMMENTS,
  parseDeliveryQualityResponse,
  QUALITY_RETRY_SUFFIX,
  samplePullsForQuality,
  truncateDiff,
  type QualityEvidenceItem,
  type QualityPromptPr,
} from "@caliber/evaluator";
import { decryptCredential, safeErrorMessage } from "@caliber/gateway-core";
import { createGithubClient } from "../githubSync/githubClient.js";
import { createFacetLlmClient } from "../evaluator/facetLlmClient.js";
import { createBudgetDeps } from "../evaluator/budgetDeps.js";
import {
  DELIVERY_ANALYSIS_EVENT_TYPE,
  REF_TYPE_GITHUB_DELIVERY_REPORT,
  isDeepAnalysisEnforceEnabled,
  writeDeepAnalysisLedger,
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

  const enforce = isDeepAnalysisEnforceEnabled();
  if (enforce) {
    try {
      await enforceBudget(input.orgId, 0, createBudgetDeps(input.db));
    } catch (err) {
      if (isBudgetError(err)) {
        return { status: "budget_denied" };
      }
      // Fail-open on non-budget infra errors (mirrors deepAnalysisBudgetGate).
    }
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
  const first = await llmClient.call({
    model: org.llmEvalModel,
    system: prompt.system,
    user: prompt.user,
    maxTokens: QUALITY_MAX_TOKENS,
  });

  let parsed = parseDeliveryQualityResponse(first.text);
  let requestId = first.requestId;

  if (!parsed.ok) {
    const retry = await llmClient.call({
      model: org.llmEvalModel,
      system: prompt.system,
      user: prompt.user + QUALITY_RETRY_SUFFIX,
      maxTokens: QUALITY_MAX_TOKENS,
    });
    parsed = parseDeliveryQualityResponse(retry.text);
    requestId = retry.requestId;
  }

  if (!parsed.ok) {
    return { status: "parse_error", model: org.llmEvalModel };
  }

  // 6. On ok: poll usage_logs for the real cost (own poll, independent of
  // the ledger's internal poll below), then ledger (best-effort — a ledger
  // failure logs and is swallowed; costUsd stays whatever this poll found).
  const calledAt = new Date();
  let costUsd: number | null = null;

  if (requestId) {
    const sleep = input.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    costUsd = await pollUsageLogCost(input.db, requestId, sleep);

    try {
      await writeDeepAnalysisLedger({
        db: input.db,
        orgId: input.orgId,
        reportId: input.reportId,
        refType: REF_TYPE_GITHUB_DELIVERY_REPORT,
        eventType: DELIVERY_ANALYSIS_EVENT_TYPE,
        usageLogRequestId: requestId,
        sleepMs: sleep,
      });
    } catch (err) {
      input.logger?.warn(
        { err: safeErrorMessage(err), orgId: input.orgId, reportId: input.reportId },
        "github-delivery quality: ledger write failed",
      );
    }
  }

  return {
    status: "ok",
    qualityAdjustment: parsed.qualityAdjustment,
    narrative: parsed.narrative,
    evidence: parsed.evidence,
    model: org.llmEvalModel,
    calledAt,
    costUsd,
  };
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
