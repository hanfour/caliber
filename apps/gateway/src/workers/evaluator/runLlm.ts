import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { usageLogs, organizations } from "@caliber/db";
import type { Redis } from "ioredis";
import {
  buildPrompt,
  sampleSnippets,
  parseLlmResponse,
  type Rubric,
  type Report,
  type LlmResponse,
  type BodyRow,
} from "@caliber/evaluator";
import { EVAL_PIN_HEADER } from "../../runtime/evalAccountPin.js";

export const LLM_KEY_REDIS_PREFIX = "caliber:gw:llm-eval-key:";
export const LLM_COST_LOOKUP_MAX_ATTEMPTS = 3;
export const LLM_COST_LOOKUP_DELAY_MS = 250;

export interface LlmMetrics {
  gwEvalLlmFailedTotal?: { inc: (labels: { reason: string }) => void };
  gwEvalLlmParseFailedTotal?: { inc: () => void };
}

export interface RunLlmDeepAnalysisInput {
  db: Database;
  redis: Redis;
  gatewayBaseUrl: string; // e.g. "http://localhost:3002"
  orgId: string;
  rubric: Rubric;
  ruleBasedReport: Report;
  bodies: BodyRow[];
  capturedAtMap?: Map<string, string>;
  fetchImpl?: typeof fetch; // For test injection
  sleepMs?: (ms: number) => Promise<void>;
  metrics?: LlmMetrics; // For test injection and metric emission
}

export interface LlmDeepAnalysisResult {
  narrative: string;
  evidence: LlmResponse["evidence"];
  sectionAdjustments: LlmResponse["sectionAdjustments"];
  model: string;
  costUsd: number; // Pulled from usage_logs; 0 if lookup failed
  requestId: string; // The X-Request-Id from the loopback call
  upstreamAccountId: string | null; // From usage_logs
}

/**
 * Runs LLM deep analysis by posting to the gateway's own /v1/messages.
 * Returns null on ANY failure — caller continues with rule-based report.
 */
export async function runLlmDeepAnalysis(
  input: RunLlmDeepAnalysisInput,
): Promise<LlmDeepAnalysisResult | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const sleep =
    input.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  try {
    // 1. Fetch the org's LLM eval api key from Redis
    const rawKey = await input.redis.get(
      `${LLM_KEY_REDIS_PREFIX}${input.orgId}`,
    );
    if (!rawKey) {
      input.metrics?.gwEvalLlmFailedTotal?.inc({ reason: "missing_key" });
      return null;
    }

    // 2. Fetch org's configured LLM eval model
    const orgRow = await input.db
      .select({
        llmEvalModel: organizations.llmEvalModel,
        llmEvalEnabled: organizations.llmEvalEnabled,
        llmEvalAccountId: organizations.llmEvalAccountId,
      })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1)
      .then((r) => r[0]);

    if (!orgRow?.llmEvalEnabled) {
      input.metrics?.gwEvalLlmFailedTotal?.inc({ reason: "disabled" });
      return null;
    }

    if (!orgRow.llmEvalModel) {
      input.metrics?.gwEvalLlmFailedTotal?.inc({ reason: "missing_key" });
      return null;
    }

    // 3. Build prompt
    const snippets = sampleSnippets({
      bodies: input.bodies,
      capturedAtMap: input.capturedAtMap,
    });
    const prompt = buildPrompt({
      rubric: input.rubric,
      ruleBasedReport: input.ruleBasedReport,
      snippets,
    });

    // 4. Call gateway loopback
    const url = `${input.gatewayBaseUrl.replace(/\/$/, "")}/v1/messages`;
    const body = {
      model: orgRow.llmEvalModel,
      max_tokens: 4000,
      system: prompt.system,
      messages: prompt.messages,
    };

    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    const headers: Record<string, string> = orgRow.llmEvalAccountId
      ? {
          ...baseHeaders,
          [EVAL_PIN_HEADER]: orgRow.llmEvalAccountId,
        }
      : baseHeaders;

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      input.metrics?.gwEvalLlmFailedTotal?.inc({ reason: "fetch_error" });
      return null;
    }

    if (!res.ok) {
      input.metrics?.gwEvalLlmFailedTotal?.inc({
        reason: "fetch_non_2xx",
      });
      return null;
    }

    const requestId =
      res.headers.get("x-request-id") ?? res.headers.get("X-Request-Id");
    if (!requestId) return null;

    const upstreamJson: unknown = await res.json();

    // 5. Parse LLM response
    const llmTextContent = extractAnthropicText(upstreamJson);
    if (llmTextContent === null) return null;

    const parsed = parseLlmResponse(llmTextContent);
    if (!parsed.ok) {
      input.metrics?.gwEvalLlmFailedTotal?.inc({ reason: "parse_error" });
      input.metrics?.gwEvalLlmParseFailedTotal?.inc();
      return null;
    }

    // 6. Pull cost back from usage_logs (wait for the row to materialize)
    let costUsd = 0;
    let upstreamAccountId: string | null = null;
    for (let i = 0; i < LLM_COST_LOOKUP_MAX_ATTEMPTS; i++) {
      const row = await input.db
        .select({
          totalCost: usageLogs.totalCost,
          accountId: usageLogs.accountId,
        })
        .from(usageLogs)
        .where(eq(usageLogs.requestId, requestId))
        .limit(1)
        .then((r) => r[0]);

      if (row) {
        costUsd = Number(row.totalCost);
        upstreamAccountId = row.accountId;
        break;
      }
      if (i < LLM_COST_LOOKUP_MAX_ATTEMPTS - 1) {
        await sleep(LLM_COST_LOOKUP_DELAY_MS);
      }
    }

    return {
      narrative: parsed.narrative,
      evidence: parsed.evidence,
      sectionAdjustments: parsed.sectionAdjustments,
      model: orgRow.llmEvalModel,
      costUsd,
      requestId,
      upstreamAccountId,
    };
  } catch {
    return null;
  }
}

function extractAnthropicText(resp: unknown): string | null {
  if (typeof resp !== "object" || resp === null) return null;
  const content = (resp as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}
