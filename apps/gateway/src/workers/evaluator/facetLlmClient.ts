/**
 * Concrete `LlmClient` for facet extraction (Plan 4C follow-up #1).
 *
 * Adapts an Anthropic-style POST against the gateway's own /v1/messages
 * endpoint to the abstract `LlmClient` interface that
 * `callWithCostTracking` (from `@caliber/evaluator`) expects.
 *
 * Mirrors the fetch pattern from `runLlmDeepAnalysis` in `runLlm.ts` so the
 * loopback flow is identical: gateway → its own /v1/messages → upstream
 * Anthropic. This keeps cost tracking (`usage_logs` row written by the
 * gateway pipeline) consistent across facet calls and deep-analysis calls.
 *
 * Error semantics:
 *   - Non-2xx throws an Error carrying `status`; `extractOne` (in the
 *     evaluator) classifies 429/5xx as transient (skip row, retry next pass)
 *     and other statuses as deterministic (writes an error row to avoid
 *     retrying the same prompt_version).
 *   - Fetch failure / missing API key throw plain Errors (deterministic).
 *
 * Return shape (PR3 delivery-quality follow-up): also surfaces the
 * loopback response's `x-request-id` as `requestId` on the resolved
 * `LlmResponse` (a widened, optional field — see callWithCostTracking.ts).
 * Facet extraction (which computes cost client-side from `usage` via
 * `calculateCost`) ignores it; `runDeliveryQuality` (which instead polls
 * `usage_logs` for the REAL post-markup cost, mirroring `runLlmDeepAnalysis`)
 * is the reason this was added — reusing this client rather than forking it.
 */

import type { Redis } from "ioredis";
import type { LlmClient } from "@caliber/evaluator";
import { LLM_KEY_REDIS_PREFIX } from "./runLlm.js";
import { EVAL_PIN_HEADER } from "../../runtime/evalAccountPin.js";

export interface FacetLlmClientDeps {
  redis: Redis;
  /** Base URL of this gateway, e.g. "http://localhost:3002". */
  gatewayBaseUrl: string;
  /** Org id used to look up the LLM eval API key in Redis. */
  orgId: string;
  /**
   * The org's pinned eval upstream (`organizations.llm_eval_account_id`).
   * Without the pin the loopback call falls through to normal scheduling,
   * which has no pool-eligible upstream in single-owner deployments →
   * every facet call 503s (`no_upstream_available`). Same mechanism
   * `runLlmDeepAnalysis` already uses.
   */
  evalAccountId?: string | null;
  /** For test injection — overrides global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build an `LlmClient` that proxies through the gateway's loopback
 * /v1/messages endpoint. Returns a fresh closure on each call.
 */
export function createFacetLlmClient(deps: FacetLlmClientDeps): LlmClient {
  return {
    async call({ model, system, user, maxTokens }) {
      const fetchFn = deps.fetchImpl ?? fetch;

      const rawKey = await deps.redis.get(
        `${LLM_KEY_REDIS_PREFIX}${deps.orgId}`,
      );
      if (!rawKey) {
        throw new Error("Facet LLM key missing for org");
      }

      const url = `${deps.gatewayBaseUrl.replace(/\/$/, "")}/v1/messages`;

      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${rawKey}`,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(deps.evalAccountId
              ? { [EVAL_PIN_HEADER]: deps.evalAccountId }
              : {}),
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: "user", content: user }],
          }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Facet LLM fetch failed: ${msg}`);
      }

      if (!res.ok) {
        const err = new Error(
          `Facet LLM call non-2xx: ${res.status}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const text = (json.content ?? [])
        .filter(
          (b): b is { type: "text"; text: string } =>
            b !== null &&
            typeof b === "object" &&
            b.type === "text" &&
            typeof b.text === "string",
        )
        .map((b) => b.text)
        .join("");

      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;
      const requestId =
        res.headers.get("x-request-id") ??
        res.headers.get("X-Request-Id") ??
        undefined;

      return {
        text,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        requestId,
      };
    },
  };
}
