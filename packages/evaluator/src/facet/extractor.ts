/**
 * Single-session facet extractor (Plan 4C Phase 2 Part 15).
 *
 * `extractOne` runs one LLM call (via the injected `callWithCostTracking`),
 * parses the response, and persists a `request_body_facets` row. Pure-deps
 * style — the caller (gateway worker) wires concrete LLM client + budget
 * deps + ledger writer + facet writer.
 *
 * Error handling philosophy:
 *   - Deterministic failures (parse / validation / local timeout) write a
 *     row with `extractionError` populated so the same prompt_version is
 *     not retried. Returns null.
 *   - Transient failures (BudgetExceeded* / 5xx) skip the row entirely so
 *     they retry on the next ensureFacets pass. Returns null.
 */

import {
  CURRENT_PROMPT_VERSION,
  buildFacetPrompt,
  type Turn,
} from "./promptBuilder.js";
import {
  parseFacet,
  FacetParseError,
  FacetValidationError,
  type FacetFields,
} from "./parser.js";
import { isBudgetError } from "../budget/errors.js";

export interface FacetSession {
  requestId: string;
  orgId: string;
  turns: Turn[];
}

export type FacetEventType = "facet_extraction";

export interface FacetRow {
  requestId: string;
  orgId: string;
  sessionType: string | null;
  outcome: string | null;
  claudeHelpfulness: number | null;
  frictionCount: number | null;
  bugsCaughtCount: number | null;
  codexErrorsCount: number | null;
  extractedWithModel: string;
  promptVersion: number;
  extractionError: string | null;
}

export interface FacetCallDeps {
  /**
   * Wraps the LLM call AND budget enforcement. Same signature as
   * `callWithCostTracking` from `@caliber/evaluator/llm/callWithCostTracking`.
   * The gateway wires this with concrete LLM client + budget deps + ledger writer.
   */
  callWithCostTracking: (args: {
    orgId: string;
    eventType: FacetEventType;
    model: string;
    refType?: "request_body_facet";
    refId?: string;
    prompt: { system: string; user: string; maxTokens: number };
    estimatedInputTokens: number;
  }) => Promise<{
    response: {
      text: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    cost: number;
  }>;

  insertFacet: (row: FacetRow) => Promise<void>;

  facetModel: string;
}

function classifyDeterministicError(e: unknown): string | null {
  if (e instanceof FacetParseError) return `parse_error: ${e.message}`;
  if (e instanceof FacetValidationError)
    return `validation_error: ${e.message}`;
  if (e instanceof Error && /timeout/i.test(e.message))
    return `timeout: ${e.message}`;
  return null;
}

function isTransientApiError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: number }).status;
  return typeof status === "number" && status >= 500 && status < 600;
}

/**
 * Try to extract facets for a single session.
 *
 * Returns the parsed `FacetFields` on success, or `null` if the extraction
 * failed for any reason. On deterministic failures (parse/validation/timeout)
 * a row is written with `extractionError` populated so the same prompt_version
 * is not retried. Transient failures (5xx, budget) skip the row entirely so
 * they retry on the next ensureFacets pass.
 */
export async function extractOne(
  session: FacetSession,
  deps: FacetCallDeps,
): Promise<FacetFields | null> {
  const prompt = buildFacetPrompt({ turns: session.turns });
  const estimatedInputTokens = Math.ceil(
    (prompt.system.length + prompt.user.length) / 4,
  );

  let response: {
    text: string;
    usage: { input_tokens: number; output_tokens: number };
  };
  try {
    const result = await deps.callWithCostTracking({
      orgId: session.orgId,
      eventType: "facet_extraction",
      model: deps.facetModel,
      refType: "request_body_facet",
      refId: session.requestId,
      prompt,
      estimatedInputTokens,
    });
    response = result.response;
  } catch (e) {
    if (isBudgetError(e)) return null; // transient — retry next eval
    if (isTransientApiError(e)) return null;

    // local error like timeout; treat as deterministic
    const errLabel =
      classifyDeterministicError(e) ??
      `unknown_error: ${e instanceof Error ? e.message : String(e)}`;
    await deps.insertFacet(emptyFacetRow(session, deps.facetModel, errLabel));
    return null;
  }

  try {
    const facet = parseFacet(response.text);
    await deps.insertFacet({
      requestId: session.requestId,
      orgId: session.orgId,
      sessionType: facet.sessionType,
      outcome: facet.outcome,
      claudeHelpfulness: facet.claudeHelpfulness,
      frictionCount: facet.frictionCount,
      bugsCaughtCount: facet.bugsCaughtCount,
      codexErrorsCount: facet.codexErrorsCount,
      extractedWithModel: deps.facetModel,
      promptVersion: CURRENT_PROMPT_VERSION,
      extractionError: null,
    });
    return facet;
  } catch (e) {
    const errLabel =
      classifyDeterministicError(e) ??
      `unknown_error: ${e instanceof Error ? e.message : String(e)}`;
    await deps.insertFacet(emptyFacetRow(session, deps.facetModel, errLabel));
    return null;
  }
}

function emptyFacetRow(
  session: FacetSession,
  model: string,
  error: string,
): FacetRow {
  return {
    requestId: session.requestId,
    orgId: session.orgId,
    sessionType: null,
    outcome: null,
    claudeHelpfulness: null,
    frictionCount: null,
    bugsCaughtCount: null,
    codexErrorsCount: null,
    extractedWithModel: model,
    promptVersion: CURRENT_PROMPT_VERSION,
    extractionError: error,
  };
}
