import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolChoice,
  AnthropicToolDef,
} from "./types.js";
import { BodyTranslationError } from "./anthropicToResponses.js";
import type {
  ResponsesInputContent,
  ResponsesInputItem,
  ResponsesInputMessage,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
} from "./responsesTypes.js";

// Plan 5A §10.3 — translate an OpenAI Responses API request body into an
// Anthropic Messages API request body.  Pure function.  Used by the
// gateway when a Responses-format client (Codex CLI) is routed to an
// Anthropic upstream account.
//
// Mapping (inverse of anthropicToResponses):
//   - `instructions`         → `system`
//   - `input` (string)       → single user message with that string
//   - `input` (item array)   → message folding (consecutive `message` items
//                              keep their role; `function_call` becomes a
//                              tool_use block on assistant; `function_call_output`
//                              becomes a tool_result block on user)
//   - `tools`                → `tools`
//   - `tool_choice`:
//       'auto'      → { type: 'auto' }
//       'none'      → tools field DROPPED (Anthropic has no 'none'; the
//                     only way to honour 'don't call any tool' is to not
//                     advertise any)
//       'required'  → { type: 'any' }
//       function:N  → { type: 'tool', name: N }
//   - `max_output_tokens`    → `max_tokens`
//   - `temperature`/`top_p`/`stream` → carry through
//
// Rejected (per design A6 / §9.4):
//   - `previous_response_id` is allowed by the schema (sticky scheduling
//     uses it) but the field has no Anthropic counterpart and is dropped
//     here.  The route handler is the layer that observes it for the
//     scheduler before invoking translation.
//   - `store` is silently dropped by the route handler before Zod
//     parsing (see SILENTLY_DROPPED_FIELDS in routes/responses.ts) so
//     the translator never sees it. aide doesn't honour OpenAI's
//     server-side response storage either way.

const DEFAULT_MAX_TOKENS = 4096;

const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const);

type AllowedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export function translateResponsesToAnthropic(
  body: ResponsesRequest,
): AnthropicMessagesRequest {
  const out: AnthropicMessagesRequest = {
    model: body.model,
    messages: translateInputToMessages(body.input),
    max_tokens: body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (body.instructions !== undefined) out.system = body.instructions;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.tools && body.tools.length > 0) {
    out.tools = body.tools.map(translateTool);
  }
  if (body.tool_choice !== undefined) {
    const tc = translateToolChoice(body.tool_choice);
    if (tc.dropTools) {
      // 'none' semantics: don't advertise any tool to the model.  Drop
      // both the tools array and any tool_choice — Anthropic with no
      // tools and no tool_choice can't invoke tools.
      delete out.tools;
    } else if (tc.tool_choice) {
      out.tool_choice = tc.tool_choice;
    }
  }

  return out;
}

function translateInputToMessages(
  input: ResponsesRequest["input"],
): AnthropicMessage[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  // Fold the heterogeneous input-item stream back into Anthropic
  // messages.  Strategy: walk forward, keep an "open" message we're
  // accumulating into, flush whenever the role changes or we hit a
  // function-call/function-call-output that needs to attach to a
  // specific role.
  const messages: AnthropicMessage[] = [];
  let openRole: AnthropicMessage["role"] | null = null;
  let openBlocks: AnthropicContentBlock[] = [];

  const flush = () => {
    if (openRole !== null && openBlocks.length > 0) {
      messages.push({ role: openRole, content: openBlocks });
    }
    openRole = null;
    openBlocks = [];
  };

  const ctx: MessageItemContext = {
    getOpenRole: () => openRole,
    flush,
    setOpenRole: (r) => {
      openRole = r;
    },
    appendBlocks: (b) => openBlocks.push(...b),
  };

  for (const item of input) {
    // Older clients sometimes omit the `type` discriminator on plain
    // message items (the schema declares it `optional()`); treat both
    // `undefined` and the explicit "message" tag as message items.
    // After this guard, item narrows to function_call | function_call_output
    // and the switch's `never` exhaustiveness check fires on any new
    // input-item variant added to the schema.
    if (item.type === undefined || item.type === "message") {
      handleMessageItem(item, ctx);
      continue;
    }

    // The message branch is peeled off above.  Cast to the remaining
    // union members so TS can narrow inside the switch — the optional
    // discriminator on the message variant prevents normal narrowing
    // across the early-return.
    const fnItem = item as Exclude<ResponsesInputItem, ResponsesInputMessage>;
    switch (fnItem.type) {
      case "function_call": {
        const block: AnthropicContentBlock = {
          type: "tool_use",
          id: fnItem.call_id,
          name: fnItem.name,
          input: parseFunctionArguments(fnItem.arguments),
        };
        if (openRole !== "assistant") flush();
        openRole = "assistant";
        openBlocks.push(block);
        break;
      }
      case "function_call_output": {
        const block: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: fnItem.call_id,
          content: fnItem.output,
        };
        if (openRole !== "user") flush();
        openRole = "user";
        openBlocks.push(block);
        break;
      }
      default: {
        // Exhaustiveness — adding a new non-message ResponsesInputItem
        // variant breaks compilation here until handled.
        const _exhaust: never = fnItem;
        throw new BodyTranslationError(
          "responses_unknown_input_item_type",
          `unknown input item type: ${(_exhaust as { type?: string }).type ?? "<missing>"}`,
        );
      }
    }
  }

  flush();
  return messages;
}

interface MessageItemContext {
  getOpenRole: () => AnthropicMessage["role"] | null;
  flush: () => void;
  setOpenRole: (r: AnthropicMessage["role"]) => void;
  appendBlocks: (b: AnthropicContentBlock[]) => void;
}

function handleMessageItem(
  msg: ResponsesInputMessage,
  ctx: MessageItemContext,
): void {
  if (msg.role === "system") {
    throw new BodyTranslationError(
      "responses_input_system_role_unsupported",
      "system-role messages in `input` are not supported; pass `instructions` at the request level instead",
    );
  }

  const role: AnthropicMessage["role"] = msg.role;
  if (ctx.getOpenRole() !== role) ctx.flush();
  ctx.setOpenRole(role);
  ctx.appendBlocks(translateMessageContent(msg.content));
}

function translateMessageContent(
  content: string | ResponsesInputContent[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content } satisfies AnthropicTextBlock];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case "input_text":
      case "output_text":
        blocks.push({
          type: "text",
          text: part.text,
        } satisfies AnthropicTextBlock);
        break;
      case "input_image":
        blocks.push(translateImageURLToAnthropic(part.image_url));
        break;
      default: {
        // Exhaustiveness — a new ResponsesInputContent variant breaks
        // compilation here until added.
        const _exhaust: never = part;
        throw new BodyTranslationError(
          "responses_unknown_content_type",
          `unknown input content type: ${(_exhaust as { type?: string }).type ?? "<missing>"}`,
        );
      }
    }
  }
  return blocks;
}

function translateImageURLToAnthropic(url: string): AnthropicImageBlock {
  // Data URIs map back to base64 source; http(s) URLs map to URL source.
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!match) {
      throw new BodyTranslationError(
        "responses_image_url_invalid_data_uri",
        `image_url is not a recognised base64 data URI`,
      );
    }
    const mediaType = match[1]!;
    if (!ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType as AllowedImageMediaType)) {
      throw new BodyTranslationError(
        "responses_image_media_type_unsupported",
        `image media_type "${mediaType}" is not in the Anthropic-supported set (jpeg/png/gif/webp)`,
      );
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as AllowedImageMediaType,
        data: match[2]!,
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function parseFunctionArguments(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BodyTranslationError(
      "responses_function_call_arguments_invalid_json",
      `function_call.arguments is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BodyTranslationError(
      "responses_function_call_arguments_not_object",
      "function_call.arguments must JSON-decode to an object",
    );
  }
  return parsed as Record<string, unknown>;
}

function translateTool(tool: ResponsesTool): AnthropicToolDef {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

interface TranslatedToolChoice {
  tool_choice?: AnthropicToolChoice;
  /** When true, the caller must drop the `tools` field entirely so
   *  Anthropic can't invoke any tool — the only honest way to express
   *  Responses-API `tool_choice="none"` since Anthropic has no equivalent. */
  dropTools?: boolean;
}

function translateToolChoice(
  choice: ResponsesToolChoice,
): TranslatedToolChoice {
  if (choice === "none") return { dropTools: true };
  if (choice === "auto") return { tool_choice: { type: "auto" } };
  if (choice === "required") return { tool_choice: { type: "any" } };
  return {
    tool_choice: { type: "tool", name: choice.name },
  };
}
