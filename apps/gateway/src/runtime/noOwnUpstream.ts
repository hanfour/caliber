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
