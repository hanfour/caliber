import { z } from "zod";

// Plan 5A §9.4 — OpenAI Responses API request/response shape.  Subset
// supported by 5A: text + function-calling.  Decision A6 explicitly
// rejects file_search / code_interpreter / image / structured-outputs
// extensions with HTTP 400 unsupported_feature.
//
// Reference: https://platform.openai.com/docs/api-reference/responses

// ── Input items ──────────────────────────────────────────────────────────────

/** A `message` input item is the request-side analogue of Anthropic's
 *  user/assistant message: a role + ordered content blocks. */
export const ResponsesInputContentTextSchema = z.object({
  type: z.enum(["input_text", "output_text"]),
  text: z.string(),
});

export const ResponsesInputContentImageSchema = z.object({
  type: z.literal("input_image"),
  image_url: z.string(),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

export const ResponsesInputContentSchema = z.union([
  ResponsesInputContentTextSchema,
  ResponsesInputContentImageSchema,
]);

export const ResponsesInputMessageSchema = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ResponsesInputContentSchema)]),
});

/** Tool call output — the user's submission of a previous function-call's
 *  result.  Mirrors Anthropic's `tool_result` content block. */
export const ResponsesInputFunctionCallOutputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

/** Function-call output item from a previous turn (assistant-side echo).
 *  Used when the client replays history that includes a prior tool call.
 */
export const ResponsesInputFunctionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const ResponsesInputItemSchema = z.union([
  ResponsesInputMessageSchema,
  ResponsesInputFunctionCallSchema,
  ResponsesInputFunctionCallOutputSchema,
]);

// ── Tools ────────────────────────────────────────────────────────────────────

export const ResponsesToolFunctionSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
  strict: z.boolean().optional(),
});

export const ResponsesToolSchema = ResponsesToolFunctionSchema;

export const ResponsesToolChoiceAutoSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("required"),
]);

export const ResponsesToolChoiceFunctionSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
});

export const ResponsesToolChoiceSchema = z.union([
  ResponsesToolChoiceAutoSchema,
  ResponsesToolChoiceFunctionSchema,
]);

// ── Request ──────────────────────────────────────────────────────────────────

export const ResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    tools: z.array(ResponsesToolSchema).optional(),
    tool_choice: ResponsesToolChoiceSchema.optional(),
    stream: z.boolean().optional(),
    /**
     * Per design A6 — client-supplied `previous_response_id` is allowed
     * (the gateway uses it for sticky scheduling in Part 7) but `store`
     * is rejected by `.strict()` below: any unknown key (including
     * `store`, `parallel_tool_calls`, `reasoning`, etc.) raises a zod
     * error so the route handler can return HTTP 400
     * `unsupported_feature` rather than silently dropping fields.
     */
    previous_response_id: z.string().optional(),
  })
  .strict();

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;
export type ResponsesInputMessage = z.infer<typeof ResponsesInputMessageSchema>;
export type ResponsesInputFunctionCall = z.infer<
  typeof ResponsesInputFunctionCallSchema
>;
export type ResponsesInputFunctionCallOutput = z.infer<
  typeof ResponsesInputFunctionCallOutputSchema
>;
export type ResponsesInputContent = z.infer<typeof ResponsesInputContentSchema>;
export type ResponsesTool = z.infer<typeof ResponsesToolSchema>;
export type ResponsesToolChoice = z.infer<typeof ResponsesToolChoiceSchema>;

// ---------------------------------------------------------------------------
// Plan 5A §10 — OpenAI Responses API response shape (non-stream).
//
// These are upstream-shape types — used by response translators only —
// and not validated against client input, so we don't define Zod
// schemas for them. The shapes follow the public OpenAI Responses API
// contract (`POST /v1/responses` non-stream return). See
// https://platform.openai.com/docs/api-reference/responses/object
//
// Subset gated by design A6: text + function-calling only. Other output
// item types (file_search_call, web_search_call, code_interpreter_call,
// etc.) are out of scope and will be ignored by translators.
// ---------------------------------------------------------------------------

export interface ResponsesOutputTextContent {
  type: "output_text";
  text: string;
  /** Echoed annotations array; we don't translate these. */
  annotations?: unknown[];
}

export interface ResponsesOutputMessageItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "incomplete" | "in_progress";
  content: ResponsesOutputTextContent[];
}

export interface ResponsesOutputFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  /** JSON string — matches Anthropic tool_use input shape after parse. */
  arguments: string;
  status?: "completed" | "incomplete" | "in_progress";
}

export type ResponsesOutputItem =
  | ResponsesOutputMessageItem
  | ResponsesOutputFunctionCallItem;

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** OpenAI surfaces cached-input details here when present. */
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "incomplete" | "failed" | "in_progress";
  output: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  /**
   * Set when status is "incomplete" — drives the stop-reason translation.
   * The `(string & {})` branding keeps the literals visible to autocomplete
   * while still permitting unknown future values from upstream (e.g. when
   * OpenAI introduces a new reason that isn't in our translator yet).
   * Without the branding TypeScript widens the union to plain `string`,
   * silently erasing the documented values.
   */
  incomplete_details?: {
    reason:
      | "max_output_tokens"
      | "content_filter"
      // eslint-disable-next-line @typescript-eslint/ban-types
      | (string & {});
  } | null;
}

/**
 * Read the `usage` block off an unknown OpenAI Responses non-stream
 * response body. Returns null when the upstream omitted usage (error
 * response, malformed body, etc.). Defensive — caller decides between
 * a null `upstreamResponse` (zero-cost log row) and a synthetic shape
 * with real numbers.
 */
export function extractResponsesUsage(resp: unknown): ResponsesUsage | null {
  if (!resp || typeof resp !== "object") return null;
  const u = (resp as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return null;
  const usage = u as Record<string, unknown>;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const total =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : input + output;
  const details = usage.input_tokens_details as
    | { cached_tokens?: unknown }
    | undefined;
  const cached =
    details && typeof details.cached_tokens === "number"
      ? details.cached_tokens
      : undefined;
  const result: ResponsesUsage = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
  if (cached !== undefined) {
    result.input_tokens_details = { cached_tokens: cached };
  }
  return result;
}
