// Plan 5A — synthetic Anthropic-response shapes for the streaming
// usage-log path.
//
// `emitUsageLog` (`runtime/usageLogging.ts`) reads `usage.input_tokens`
// + `usage.output_tokens` (+ optional cache fields) off a parsed
// Anthropic Messages response shape.  Streaming routes don't have that
// shape directly — they have the per-chunk usage extracted from the
// terminal stream event in whatever the *client* SSE format was.  Both
// streaming routes (chatCompletions + responses) ended up writing
// near-identical helpers to fold their captured usage back into a
// minimal Anthropic shape so the existing pricing path could run
// unchanged. Centralising the shape here keeps the contract in one
// place — if `emitUsageLog` ever cares about another usage field, only
// one helper changes.
//
// `id` / `model` are required by the row writer's logging path (it
// surfaces `upstreamModel` in pricing-miss warnings) but pricing
// itself ignores them.

export interface SyntheticAnthropicUsageShape {
  id: string;
  type: "message";
  role: "assistant";
  content: [];
  model: string;
  stop_reason: null;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export interface SyntheticUsageInput {
  id: string;
  model: string;
  /** Non-cached input tokens — already split if upstream surfaced cache. */
  inputTokens: number;
  outputTokens: number;
  /** Cache hit token count, or 0 if upstream didn't surface cache. */
  cacheReadInputTokens?: number;
  /** Cache write token count, or 0 if upstream didn't surface cache. */
  cacheCreationInputTokens?: number;
}

export function buildSyntheticAnthropicUsage(
  input: SyntheticUsageInput,
): SyntheticAnthropicUsageShape {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    content: [],
    model: input.model,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cache_creation_input_tokens: input.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: input.cacheReadInputTokens ?? 0,
    },
  };
}
