/**
 * Adapter: `BodyRow` → `FacetSession` (Plan 4C follow-up #1).
 *
 * Converts a single decrypted Anthropic-shaped request/response pair (as
 * produced by `runRuleBased`) into the `{requestId, orgId, turns}` shape
 * that `extractOne` consumes.
 *
 * Anthropic message shape (from `runRuleBased.ts → tryParse`):
 *   - `requestBody`  ≈ { messages: [{ role, content }, ...], system?: string }
 *   - `responseBody` ≈ { content: [{ type: "text", text }, ...], stop_reason }
 *
 * Defensive: many shapes are possible (string content, block array, missing
 * fields, tool_use/tool_result blocks). Returns `null` if no usable
 * conversational turns can be reconstructed — caller should drop the
 * session rather than send an empty prompt to the LLM.
 */

import type { BodyRow } from "@caliber/evaluator";
import type { FacetSession, Turn } from "@caliber/evaluator";

const TOOL_RESULT_TEXT_LIMIT = 500;

/**
 * Flatten Anthropic message content (string or block-array) into a single
 * string. Skips image blocks; surfaces tool_use/tool_result blocks with a
 * lightweight marker so the facet model still sees that tools were used.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;

    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "?";
      parts.push(`[tool_use: ${name}]`);
    } else if (b.type === "tool_result") {
      // Tool results may carry useful diagnostic text — recurse, then trim
      // to keep the prompt bounded.
      const innerText = flattenContent(b.content);
      if (innerText) {
        parts.push(
          `[tool_result: ${innerText.slice(0, TOOL_RESULT_TEXT_LIMIT)}]`,
        );
      }
    }
    // image / other block types: silently skipped.
  }
  return parts.join("\n");
}

/**
 * Convert one decrypted body row into a FacetSession. Returns null when
 * neither the request messages nor the response yield any usable text.
 */
export function bodyRowToFacetSession(
  body: BodyRow,
  orgId: string,
): FacetSession | null {
  const turns: Turn[] = [];

  // 1. Walk request messages
  const reqBody = body.requestBody as
    | { messages?: Array<{ role?: string; content?: unknown }> }
    | null
    | undefined;
  const messages = reqBody?.messages;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = flattenContent(m.content);
      if (text) {
        turns.push({ role: m.role, content: text });
      }
    }
  }

  // 2. Append assistant response (one final turn)
  const respBody = body.responseBody as
    | { content?: Array<{ type?: string; text?: string }> }
    | null
    | undefined;
  const respText = flattenContent(respBody?.content);
  if (respText) {
    turns.push({ role: "assistant", content: respText });
  }

  if (turns.length === 0) return null;

  return {
    requestId: body.requestId,
    orgId,
    turns,
  };
}
