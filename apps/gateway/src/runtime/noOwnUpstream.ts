// BYOK §4.1 — shared 409 `no_own_upstream` reply body.
//
// Thrown as `NoOwnUpstreamError` by `runFailover` when a bare `own`-policy
// key has NO non-deleted upstream registered for the request's platform.
// Centralised here so every surface (/v1/messages, /v1/chat/completions,
// /v1/responses) emits an identical 409 shape + message.
//
// NOTE: the gateway has no fastify `setErrorHandler`, so each route catch
// block MUST produce this 409 explicitly (`reply.code(409).send(...)` or the
// raw equivalent for hijacked streams). A bare re-throw would default to 500.
//
// Kept in `runtime/` (NOT `routes/`) because `sseErrorEvents.ts` (runtime)
// imports this helper — placing it here keeps the runtime layer self-contained
// and avoids a runtime→routes import inversion.

import type { Platform } from "@caliber/gateway-core";

/** HTTP status for the no-own-upstream existence error. */
export const NO_OWN_UPSTREAM_STATUS = 409 as const;

export interface NoOwnUpstreamBody {
  error: "no_own_upstream";
  message: string;
  request_id: string;
}

/**
 * Build the JSON body for a `no_own_upstream` 409. The message intentionally
 * names the platform so the client can point the user at the right settings
 * surface ("add one in settings").
 */
export function noOwnUpstreamReplyBody(
  platform: Platform,
  requestId: string,
): NoOwnUpstreamBody {
  return {
    error: "no_own_upstream",
    message: `No credential registered for ${platform} — add one in settings`,
    request_id: requestId,
  };
}

/** HTTP status for the all-candidates-rate-limited transient error. */
export const RATE_LIMITED_STATUS = 429 as const;

export interface RateLimitedBody {
  error: "rate_limited";
  message: string;
  retry_after: number;
  request_id: string;
}

/**
 * Build the JSON body for a `rate_limited` 429 — emitted when EVERY candidate
 * upstream is rate-limited (transient). Callers MUST also set a
 * `Retry-After: <seconds>` response header so agentic clients (Claude Code,
 * codex) back off and retry instead of treating it as a hard failure. Unlike
 * `all_upstreams_failed` (503), this signals "try again shortly", not "dead".
 */
export function rateLimitedReplyBody(
  retryAfterSec: number,
  requestId: string,
): RateLimitedBody {
  return {
    error: "rate_limited",
    message: `All upstreams are rate-limited — retry after ${retryAfterSec}s`,
    retry_after: retryAfterSec,
    request_id: requestId,
  };
}
