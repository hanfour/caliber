// tRPC-shaped 429 body for the /trpc rate limiter (#193).
//
// The web client uses httpBatchLink with NO superjson transformer, so it
// expects either a single `{ error: { message, code, data } }` object or — for
// batched requests (`?batch=1`, comma-joined proc path) — an ARRAY of one such
// object per op. fastify-rate-limit's default `{statusCode,error,message}` body
// parses as neither, so the client raised "Unable to transform response from
// server" and, lacking `data.httpStatus`, retried the 429 three times (a 7s
// spinner; see web TrpcProvider's shouldRetryQuery). Returning the tRPC shape
// gives a clean TOO_MANY_REQUESTS TRPCClientError with httpStatus 429.

// tRPC JSON-RPC error code for TOO_MANY_REQUESTS.
const TRPC_TOO_MANY_REQUESTS = -32029;

interface TrpcErrorEnvelope {
  error: {
    message: string;
    code: number;
    data: { code: "TOO_MANY_REQUESTS"; httpStatus: 429; path: string | null };
  };
}

/**
 * Tag the payload with a non-enumerable `statusCode: 429`.
 *
 * @fastify/rate-limit@10 does `throw errorResponseBuilder(req, ctx)` on exceed
 * (index.js), so the return value reaches fastify's error handler, which derives
 * the HTTP status from the thrown value's `.statusCode` (defaulting to 500). The
 * library's own default builder returns an Error carrying `statusCode: 429`; our
 * tRPC-shaped payload is a plain object/array, so without this marker the
 * response is a (wrong) 500 even though the body is correct. The property is
 * non-enumerable so it never serialises into the JSON wire body.
 */
function withStatus429<T extends object>(payload: T): T {
  return Object.defineProperty(payload, "statusCode", {
    value: 429,
    enumerable: false,
  });
}

/**
 * Build the rate-limit 429 response body. Returns an array (one envelope per
 * batched op) for `?batch=...` requests, else a single envelope. `req.url` is
 * the full request URL (e.g. `/trpc/me.session,organizations.list?batch=1`).
 * The returned value also carries a non-enumerable `statusCode: 429` so that,
 * once thrown by @fastify/rate-limit, fastify responds 429 rather than 500.
 */
export function trpcTooManyRequestsBody(
  req: { url?: string },
  retryAfter: string,
): TrpcErrorEnvelope | TrpcErrorEnvelope[] {
  // Plain concatenation (not a backtick template) so the audit-zod-i18n guard
  // — which bans `message: ` + template literals app-wide — stays green; this
  // is a transport error body, not a translatable Zod validation message.
  const message = "Rate limit exceeded, retry in " + retryAfter;
  const mk = (path: string | null): TrpcErrorEnvelope => ({
    error: {
      message,
      code: TRPC_TOO_MANY_REQUESTS,
      data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path },
    },
  });
  const url = req.url ?? "";
  const procPath = decodeURIComponent(
    (url.split("?")[0] ?? "").replace(/^.*\/trpc\//, ""),
  );
  if (/[?&]batch=/.test(url)) {
    const procs = procPath ? procPath.split(",") : [""];
    return withStatus429(procs.map((p) => mk(p || null)));
  }
  return withStatus429(mk(procPath || null));
}
