import { calculateCost } from "./pricing.js";

export interface LlmCallParams {
  orgId: string;
  eventType: "facet_extraction" | "deep_analysis";
  model: string;
  refType?: "request_body_facet" | "evaluation_report";
  refId?: string;
  prompt: { system: string; user: string; maxTokens: number };
  estimatedInputTokens: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
}

export interface LlmClient {
  call(args: {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<LlmResponse>;
}

export interface LedgerRow {
  orgId: string;
  eventType: "facet_extraction" | "deep_analysis";
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  refType?: "request_body_facet" | "evaluation_report";
  refId?: string;
}

export interface CostTrackingDeps {
  llmClient: LlmClient;
  enforceBudget: (orgId: string, estimatedCost: number) => Promise<void>;
  insertLedger: (row: LedgerRow) => Promise<void>;
}

/**
 * A ledger write failed AFTER a successful (paid) LLM call. Marked transient
 * so consumers (e.g. the facet extractor) retry next pass instead of writing
 * a permanent error row for what is usually a recoverable DB condition.
 */
export class LedgerWriteError extends Error {
  readonly name = "LedgerWriteError";
  readonly transient = true;
  constructor(cause: unknown) {
    super(
      `ledger write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function callWithCostTracking(
  params: LlmCallParams,
  deps: CostTrackingDeps,
): Promise<{ response: LlmResponse; cost: number }> {
  const estimatedCost = calculateCost(
    params.model,
    params.estimatedInputTokens,
    params.prompt.maxTokens,
  );
  await deps.enforceBudget(params.orgId, estimatedCost);

  const response = await deps.llmClient.call({
    model: params.model,
    system: params.prompt.system,
    user: params.prompt.user,
    maxTokens: params.prompt.maxTokens,
  });

  if (!response.usage) {
    throw new Error("LLM response missing usage; cannot write ledger");
  }

  const actualCost = calculateCost(
    params.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  try {
    await deps.insertLedger({
      orgId: params.orgId,
      eventType: params.eventType,
      model: params.model,
      tokensInput: response.usage.input_tokens,
      tokensOutput: response.usage.output_tokens,
      costUsd: actualCost,
      refType: params.refType,
      refId: params.refId,
    });
  } catch (e) {
    throw new LedgerWriteError(e);
  }

  return { response, cost: actualCost };
}
