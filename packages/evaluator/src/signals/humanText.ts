/**
 * v2 keyword hygiene (docs/RUBRIC_V2_DESIGN.md §6).
 *
 * Extracts the text of the LATEST genuine human turn from a stored request
 * body, so keyword scans measure what the member actually typed this turn —
 * not the accumulated history, system prompt, or tool output.
 */

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      out.push(b["text"]);
    }
  }
  return out;
}

export function extractLatestHumanText(
  requestBody: unknown,
  noiseFilters: string[],
): string | null {
  if (requestBody === null || typeof requestBody !== "object") return null;
  const messages = (requestBody as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike;
    if (msg === null || typeof msg !== "object" || msg.role !== "user") continue;

    const blocks = textBlocks(msg.content);
    if (blocks.length === 0) return null; // 最後一則 user 是純 tool_result / 空 → 無真人文字

    const lowered = noiseFilters.map((f) => f.toLowerCase());
    const clean = blocks.filter(
      (t) => !lowered.some((f) => t.toLowerCase().includes(f)),
    );
    const joined = clean.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}
