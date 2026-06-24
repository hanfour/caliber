// Plan 5A PR 9j — shared SSE error-event serializers + the post-hijack
// failover-collapse responder.  Before this module, each route file
// inlined its own copy of these three helpers (one per inbound SSE
// flavour) plus the same ~30-line catch block that branches on
// `reply.raw.headersSent` to decide whether to write an SSE error
// chunk or a JSON 503.
//
// The three serializers stay separate (rather than a single
// parameterized function) because the wire shapes genuinely differ:
//
//   * Anthropic: `event: error\ndata: {type, error: {type, message,
//     request_id}}\n\n`. SDK clients parse `error.type`.
//   * OpenAI Chat: `data: {error: {type, message, request_id}}\n\n`
//     — no `event:` prefix, the streaming format predates SSE event
//     names.
//   * OpenAI Responses: `event: error\ndata: {type, error: {kind,
//     message, request_id}}\n\n`. Note `kind` not `type` on the
//     inner object — matches what sub2api recordings show.
//
// `request_id` is included on every flavour so ops can correlate a
// failed stream with its `usage_log` row.  Forward-compatible: SDK
// error parsers ignore unknown fields.

import type { FastifyReply } from "fastify";
import {
  AllUpstreamsFailed,
  FatalUpstreamError,
  NoOwnUpstreamError,
  RateLimitedError,
} from "./failoverLoop.js";
import {
  noOwnUpstreamReplyBody,
  NO_OWN_UPSTREAM_STATUS,
  rateLimitedReplyBody,
  RATE_LIMITED_STATUS,
} from "./noOwnUpstream.js";

/**
 * Pulls the upstream body off a FatalUpstreamError when failover
 * preserved it on `cause`. Returns undefined for AllUpstreamsFailed
 * (no single upstream's body to surface) or when cause was not set.
 */
function fatalUpstreamDetail(err: unknown): string | undefined {
  if (err instanceof FatalUpstreamError && err.cause instanceof Error) {
    return err.cause.message;
  }
  return undefined;
}

/**
 * Build the JSON body the non-stream route catches send back when
 * failover terminates with a FatalUpstreamError. Centralised so the
 * `detail` (upstream body) is consistent across /v1/messages,
 * /v1/chat/completions, /v1/responses.
 */
export function fatalUpstreamReplyBody(
  err: FatalUpstreamError,
  requestId: string,
): { error: string; detail?: string; request_id: string } {
  const detail = fatalUpstreamDetail(err);
  return {
    error: err.reason,
    ...(detail !== undefined ? { detail } : {}),
    request_id: requestId,
  };
}

/** Anthropic Messages SSE error event (`/v1/messages` openai-stream). */
export function serializeAnthropicSseError(
  errType: string,
  message: string,
  requestId: string,
): string {
  const ev = {
    type: "error" as const,
    error: { type: errType, message, request_id: requestId },
  };
  return `event: error\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** OpenAI Chat Completions streaming error chunk (`/v1/chat/completions`). */
export function serializeChatSseError(
  errType: string,
  message: string,
  requestId: string,
): string {
  const ev = {
    error: { type: errType, message, request_id: requestId },
  };
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/** OpenAI Responses SSE error event (`/v1/responses`). */
export function serializeResponsesSseError(
  kind: string,
  message: string,
  requestId: string,
): string {
  const ev = {
    type: "error" as const,
    error: { kind, message, request_id: requestId },
  };
  return `event: error\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Compute the `kind` (or `type`) + `message` pair from the failover
 * loop's terminal error.  Centralised so every route uses the same
 * phrasing convention for `all_upstreams_failed` vs the
 * FatalUpstreamError's `reason`.
 */
export function failoverErrorPair(
  err: AllUpstreamsFailed | FatalUpstreamError,
): { kind: string; message: string } {
  if (err instanceof FatalUpstreamError) {
    // Prefer the upstream body (preserved on cause by failoverLoop) over
    // the wrapper's synthetic "fatal upstream: …" message — clients
    // need the actual `invalid_request_error` / `rate_limit_error`
    // text to act on.
    const detail = fatalUpstreamDetail(err);
    return { kind: err.reason, message: detail ?? err.message };
  }
  return {
    kind: "all_upstreams_failed",
    message: `all upstreams failed (attempted=${err.attemptedIds.length})`,
  };
}

/** SSE error-event serializer signature (one per inbound surface). */
export type SseErrorSerializer = (
  kindOrType: string,
  message: string,
  requestId: string,
) => string;

/**
 * Handle the post-hijack failover collapse path.  After `reply.hijack()`
 * we've taken over the response, so a terminal `AllUpstreamsFailed` /
 * `FatalUpstreamError` must be surfaced via either:
 *
 *   * an SSE error chunk (when headers were already written — i.e.
 *     a later attempt's stream started before the failover blew up
 *     OR mid-stream parser error), OR
 *   * a JSON 503/4xx (when the failover collapse happened before
 *     any attempt reached the upstream-success path that writes
 *     headers — e.g. credential resolve / scheduler emptied).
 *
 * The fallback (non-failover error → 500 JSON or just `end()`) is
 * also handled here so the calling route doesn't need a fallthrough.
 *
 * @param reply              The Fastify reply (already hijacked).
 * @param err                The error from the failover loop.
 * @param requestId          For the JSON body / SSE error event.
 * @param serializeSseError  Route-specific SSE error serializer.
 */
export function respondStreamFailoverCollapse(
  reply: FastifyReply,
  err: unknown,
  requestId: string,
  serializeSseError: SseErrorSerializer,
): void {
  if (err instanceof NoOwnUpstreamError) {
    // BYOK §4.1: existence-check 409. Always thrown before any upstream
    // attempt, so headers can't have been sent — emit the JSON 409 over the
    // hijacked socket (never an SSE error chunk).
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(NO_OWN_UPSTREAM_STATUS, {
        "content-type": "application/json",
      });
      reply.raw.end(
        JSON.stringify(noOwnUpstreamReplyBody(err.platform, requestId)),
      );
    } else {
      reply.raw.end();
    }
    return;
  }
  if (err instanceof RateLimitedError) {
    // Transient: every candidate upstream is rate-limited. Surface a 429 +
    // Retry-After so agentic clients back off, NOT a 503 they treat as dead.
    if (reply.raw.headersSent) {
      reply.raw.write(
        serializeSseError(
          "rate_limited",
          `all upstreams rate-limited — retry after ${err.retryAfterSec}s`,
          requestId,
        ),
      );
      reply.raw.end();
    } else {
      reply.raw.writeHead(RATE_LIMITED_STATUS, {
        "content-type": "application/json",
        "retry-after": String(err.retryAfterSec),
      });
      reply.raw.end(
        JSON.stringify(rateLimitedReplyBody(err.retryAfterSec, requestId)),
      );
    }
    return;
  }
  if (err instanceof AllUpstreamsFailed || err instanceof FatalUpstreamError) {
    if (reply.raw.headersSent) {
      const { kind, message } = failoverErrorPair(err);
      reply.raw.write(serializeSseError(kind, message, requestId));
      reply.raw.end();
    } else {
      reply.raw.writeHead(
        err instanceof FatalUpstreamError ? err.statusCode : 503,
        { "content-type": "application/json" },
      );
      const body =
        err instanceof FatalUpstreamError
          ? fatalUpstreamReplyBody(err, requestId)
          : { error: "all_upstreams_failed", request_id: requestId };
      reply.raw.end(JSON.stringify(body));
    }
    return;
  }
  // Unexpected error — 500 JSON if headers haven't been sent, else
  // just close the open stream so the client doesn't hang.
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(500, { "content-type": "application/json" });
    reply.raw.end(JSON.stringify({ error: "internal_error" }));
  } else {
    reply.raw.end();
  }
}
