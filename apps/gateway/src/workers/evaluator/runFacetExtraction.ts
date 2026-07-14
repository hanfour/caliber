/**
 * Top-level facet-extraction orchestrator (Plan 4C follow-up #1).
 *
 * Wires the abstract pieces shipped in Phase 2 — `ensureFacets`,
 * `extractOne`, `callWithCostTracking` — to concrete gateway adapters
 * (Drizzle DB, Redis-backed LLM key lookup, Prometheus metrics) so the
 * evaluator worker can persist facet rows when `ENABLE_FACET_EXTRACTION`
 * is on.
 *
 * Fail-soft contract: this function NEVER throws. The rule-based pipeline
 * is the source of truth; facet enrichment is best-effort. Any error is
 * captured in the returned `skippedReason` so the caller can keep going.
 *
 * Skip reasons:
 *   - "flag_off"             : ENABLE_FACET_EXTRACTION is not "true"
 *   - "facet_disabled"       : per-org `llm_facet_enabled` is false
 *   - "facet_model_missing"  : per-org `llm_facet_model` is null
 *   - "no_bodies"            : no usable conversational sessions
 *   - "extraction_error"     : ensureFacets threw (defensive belt-and-suspenders)
 */

import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { organizations } from "@caliber/db";
import type { Redis } from "ioredis";
import {
  callWithCostTracking,
  ensureFacets,
  enforceBudget as enforceBudgetCore,
  extractOne,
  type BodyRow,
  type FacetCallDeps,
  type FacetSession,
  type LlmCallParams,
} from "@caliber/evaluator";

import type { BudgetAlertEvent } from "./budgetAlertWebhook.js";
import { createBudgetDeps } from "./budgetDeps.js";
import { createFacetCacheReader } from "./facetCache.js";
import { createFacetLlmClient } from "./facetLlmClient.js";
import { createFacetWriter } from "./facetWriter.js";
import { createLedgerWriter } from "./ledgerWriter.js";
import { wrapEnforceBudget } from "./enforceBudgetWithMetrics.js";
import { bodyRowToFacetSession } from "./bodyToFacetSession.js";
import type { GatewayMetrics } from "../../plugins/metrics.js";

/** Default concurrency — tuned to balance Anthropic rate limits vs throughput. */
const FACET_CONCURRENCY = 5;

export type FacetMetrics = Pick<
  GatewayMetrics,
  | "gwLlmCostUsdTotal"
  | "gwLlmBudgetWarnTotal"
  | "gwLlmBudgetExceededTotal"
  | "gwFacetExtractTotal"
  | "gwFacetExtractDurationMs"
  | "gwFacetCacheHitTotal"
>;

export interface RunFacetExtractionInput {
  db: Database;
  redis: Redis;
  /** Base URL of this gateway, e.g. "http://localhost:3002". */
  gatewayBaseUrl: string;
  orgId: string;
  /** Decrypted body rows from `runRuleBased`. */
  bodies: BodyRow[];
  /** For test injection — overrides global fetch. */
  fetchImpl?: typeof fetch;
  /** Subset of GatewayMetrics needed by the facet pipeline. */
  metrics?: FacetMetrics;
  /** Optional sink for budget warn/exceeded webhook alerts (Plan P4). */
  onBudgetEvent?: (e: BudgetAlertEvent) => void;
}

export interface RunFacetExtractionResult {
  attempted: number;
  extracted: number;
  cacheHits: number;
  skippedReason?:
    | "flag_off"
    | "facet_disabled"
    | "facet_model_missing"
    | "no_bodies"
    | "extraction_error";
}

/**
 * Run facet extraction for the given decrypted bodies. Returns a result
 * object describing the outcome — never throws.
 */
export async function runFacetExtraction(
  input: RunFacetExtractionInput,
): Promise<RunFacetExtractionResult> {
  if (process.env.ENABLE_FACET_EXTRACTION !== "true") {
    return {
      attempted: 0,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "flag_off",
    };
  }

  // Load org facet config (separate read from the eval flow — keeps deps tight)
  const [org] = await input.db
    .select({
      llmFacetEnabled: organizations.llmFacetEnabled,
      llmFacetModel: organizations.llmFacetModel,
      llmEvalAccountId: organizations.llmEvalAccountId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);

  if (!org?.llmFacetEnabled) {
    return {
      attempted: 0,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "facet_disabled",
    };
  }
  if (!org.llmFacetModel) {
    return {
      attempted: 0,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "facet_model_missing",
    };
  }

  // Adapt bodies → sessions; drop ones with no usable conversation.
  const sessions: FacetSession[] = [];
  for (const b of input.bodies) {
    const s = bodyRowToFacetSession(b, input.orgId);
    if (s) sessions.push(s);
  }
  if (sessions.length === 0) {
    return {
      attempted: 0,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "no_bodies",
    };
  }

  // Build deps stack
  const budgetDeps = createBudgetDeps(input.db);
  const enforceBudgetFn: (orgId: string, est: number) => Promise<void> =
    input.metrics
      ? wrapEnforceBudget(
          budgetDeps,
          {
            gwLlmBudgetWarnTotal: input.metrics.gwLlmBudgetWarnTotal,
            gwLlmBudgetExceededTotal: input.metrics.gwLlmBudgetExceededTotal,
          },
          input.onBudgetEvent,
        )
      : (orgId, est) => enforceBudgetCore(orgId, est, budgetDeps);

  const insertLedger = createLedgerWriter(
    input.db,
    input.metrics
      ? { gwLlmCostUsdTotal: input.metrics.gwLlmCostUsdTotal }
      : undefined,
  );

  const llmClient = createFacetLlmClient({
    redis: input.redis,
    gatewayBaseUrl: input.gatewayBaseUrl,
    orgId: input.orgId,
    evalAccountId: org.llmEvalAccountId,
    fetchImpl: input.fetchImpl,
  });

  const insertFacet = createFacetWriter(input.db);
  const getFacet = createFacetCacheReader(input.db);

  const facetCallDeps: FacetCallDeps = {
    callWithCostTracking: (args: LlmCallParams) =>
      callWithCostTracking(args, {
        llmClient,
        enforceBudget: enforceBudgetFn,
        insertLedger,
      }),
    insertFacet,
    facetModel: org.llmFacetModel,
  };

  try {
    const result = await ensureFacets(sessions, {
      getFacet,
      extractOne: (s) => extractOne(s, facetCallDeps),
      concurrency: FACET_CONCURRENCY,
    });
    return {
      attempted: sessions.length,
      extracted: result.extracted,
      cacheHits: result.cacheHits,
    };
  } catch {
    // Belt-and-suspenders: ensureFacets is fail-soft per-session, but if
    // something escapes (e.g. Drizzle batch failure) we still don't want
    // to block the rule-based pipeline.
    return {
      attempted: sessions.length,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "extraction_error",
    };
  }
}
