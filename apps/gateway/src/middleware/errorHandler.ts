// Global Fastify `setErrorHandler` SAFETY NET for the gateway.
//
// Why this exists: the gateway's route handlers already catch their own domain
// errors (AllUpstreamsFailed → 503, NoOwnUpstreamError → 409, FatalUpstreamError
// → its status, auth → 401, rate-limit → 429) and send EXPLICIT replies via
// `reply.code().send()`. Those paths are UNAFFECTED — this handler only fires
// for errors that genuinely ESCAPE per-route handling (e.g. the `throw err`
// re-throw at the end of a route's catch block, or a throw from a preHandler
// hook such as `platformForGatewayRoute` on an unmapped BYOK route).
//
// Before this existed the gateway had NO setErrorHandler, so any escaped throw
// defaulted to a Fastify 500 with an uncontrolled body (the #198 bug class).
// This net guarantees: (a) an error carrying a `statusCode` (Fastify
// convention) is honoured; (b) everything else becomes a clean 500
// `internal_error` with the real detail logged server-side and NEVER leaked to
// the client.

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/**
 * True when the reply has already been sent or the stream was hijacked, so we
 * must NOT attempt to send again. Mirrors the gateway's streaming code, which
 * guards on `reply.raw.headersSent` before writing (see routes/messages.ts).
 * `reply.sent` covers the buffered-reply case; `reply.raw.headersSent` covers
 * hijacked/streamed responses where headers are already on the wire.
 */
function replyAlreadyCommitted(reply: FastifyReply): boolean {
  return reply.sent || reply.raw.headersSent;
}

/**
 * Narrow an unknown error's `statusCode` to a valid HTTP error status we are
 * willing to honour (400–599). Anything outside that range (or non-numeric) is
 * treated as "no usable status" → caller falls back to 500.
 */
function honourableStatusCode(err: unknown): number | undefined {
  const code = (err as { statusCode?: unknown }).statusCode;
  if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) {
    return code;
  }
  return undefined;
}

/**
 * The gateway's global error handler. Registered via `app.setErrorHandler` in
 * buildServer. Kept as a standalone export so it can be unit-tested directly
 * and reused on any sub-context.
 */
export function gatewayErrorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  // 1. Streaming / hijacked / already-sent: we cannot send twice. Log and bail.
  if (replyAlreadyCommitted(reply)) {
    req.log.error(
      { err, request_id: req.id },
      "gateway error after reply committed (cannot re-send)",
    );
    return;
  }

  // 2. Honour an explicit, in-range statusCode (Fastify convention). This
  //    covers typed errors like UnsupportedRouteError (400) — the body uses
  //    the error's `errorCode` when present, else a generic `error` string.
  const status = honourableStatusCode(err);
  if (status !== undefined) {
    const rawErrorCode = (err as { errorCode?: unknown }).errorCode;
    const errorCode =
      typeof rawErrorCode === "string" ? rawErrorCode : "request_error";
    // Log the full detail server-side (pino redacts known credential paths).
    req.log.warn(
      { err, request_id: req.id, statusCode: status },
      "gateway handled error (honoured statusCode)",
    );
    reply.code(status).send({
      error: errorCode,
      message: err.message,
      request_id: req.id,
    });
    return;
  }

  // 3. Unknown error → clean 500. NEVER leak the stack/message to the client;
  //    log the real detail server-side for operators.
  req.log.error(
    { err, request_id: req.id },
    "gateway uncaught error (defaulted to 500 internal_error)",
  );
  reply.code(500).send({
    error: "internal_error",
    request_id: req.id,
  });
}
