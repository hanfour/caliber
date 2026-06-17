// Idempotency in-flight release (design §4.7). Companion to the claim made in
// `routes/idempotencyEntry.ts` via `checkRequestIdempotency`: when a request
// CLAIMS the in-flight slot on a cache miss (`req.gwIdemKey` set), this
// `onResponse` hook releases that slot if the claimant terminates with a
// non-2xx.
//
// Why: without this, a transient failure (e.g. an upstream 503) leaves the
// in-flight marker alive for the full idempotency TTL (default 300s), so a
// same-id RETRY gets `409 request_in_progress` and never re-dispatches — a
// 5-minute lockout on a recoverable error. On a 2xx the success path already
// overwrote the marker with the completed cache entry (so it MUST NOT be
// cleared — that would drop a valid replay entry); on a non-2xx the marker is
// still the bare in-flight token, so we delete it to free a retry.
//
// One central place covers ALL routes and ALL failure modes (route catch /
// capacity shed / uncaught throw routed through the error handler), and it
// naturally never fires for:
//   - duplicates (got 409, `gwIdemKey` undefined — own no slot),
//   - replays / degraded / disabled (no claim, `gwIdemKey` undefined),
//   - successes (statusCode 200 — the cache entry stays).
//
// Mirrors `waitQueuePlugin`'s claim-in-preHandler / release-in-onResponse shape.
// Best-effort: a Redis error here only fails to free the slot early; the
// marker's own TTL is the backstop, so we never fail the response over it.

import fp from "fastify-plugin";
import { clearInFlight } from "../redis/idempotency.js";

export const idempotencyReleasePlugin = fp(pluginBody, {
  name: "idempotencyReleasePlugin",
  // Needs `fastify.redis` (redisPlugin) — `req.gwIdemKey` is set by the route
  // handlers themselves, not by another plugin, so no preHandler dependency.
  dependencies: ["redisPlugin"],
});

async function pluginBody(
  fastify: import("fastify").FastifyInstance,
): Promise<void> {
  fastify.addHook("onResponse", async (req, reply) => {
    const idemKey = req.gwIdemKey;
    // Only the request that CLAIMED the slot (idemKey set) may release it, and
    // only on a non-2xx — a 2xx left a completed cache entry that must survive.
    if (!idemKey) return;
    if (reply.statusCode === 200) return;
    try {
      await clearInFlight(fastify.redis, idemKey);
    } catch {
      // Best-effort; the in-flight marker's TTL frees the slot eventually.
      fastify.gwMetrics?.redisErrorTotal.inc({ op: "idempotency" });
    }
  });
}
