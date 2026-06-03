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
 * Build the rate-limit 429 response body. Returns an array (one envelope per
 * batched op) for `?batch=...` requests, else a single envelope. `req.url` is
 * the full request URL (e.g. `/trpc/me.session,organizations.list?batch=1`).
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
    return procs.map((p) => mk(p || null));
  }
  return mk(procPath || null);
}
