// Route-level entry point for the idempotency cache (design §4.5).
//
// `runtime/idempotencyCache.ts` is deliberately framework-light — it speaks a
// minimal `ReplyLike` interface and takes its wiring (redis, ttl, failure mode,
// metric, logger) as plain fields. This wrapper bridges that helper to the
// Fastify request surface so every route shares one call shape instead of
// duplicating the ~13-line wiring block per handler.
//
// The entry runs for BOTH stream and non-stream requests — the in-flight
// marker `409`s a concurrent duplicate regardless of stream mode — but only
// non-stream 200s are stored for replay (see `storeIdempotent`).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerEnv } from "@caliber/config";
import { checkIdempotency } from "../runtime/idempotencyCache.js";

export interface RequestIdempotency {
  /**
   * true when a terminal reply (replay / conflict / degraded) was already
   * sent — the caller MUST return immediately without dispatching upstream.
   */
  handled: boolean;
  /**
   * The in-flight key claimed on a cache miss; pass to `storeIdempotent` on a
   * non-stream 200 success. null whenever there is no slot to store under —
   * i.e. when `handled` is true (a reply was already sent) OR when idempotency
   * is disabled for this request (no `X-Request-Id`, ttl 0, or a lenient-mode
   * Redis failure). Only the cache-miss "proceed" path yields a non-null key.
   */
  idemKey: string | null;
}

/**
 * Read the client `X-Request-Id` and run the idempotency check with the shared
 * app/env wiring. Returns whether the request was already answered from cache
 * (`handled`) and the in-flight `idemKey` for the success-path store.
 */
export async function checkRequestIdempotency(
  app: FastifyInstance,
  env: ServerEnv,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<RequestIdempotency> {
  const xReqId = req.headers["x-request-id"];
  const result = await checkIdempotency({
    redis: app.redis,
    ttlSec: env.GATEWAY_IDEMPOTENCY_TTL_SEC,
    failClosed: env.GATEWAY_REDIS_FAILURE_MODE === "strict",
    requestKey: Array.isArray(xReqId) ? (xReqId[0] ?? null) : (xReqId ?? null),
    reply,
    onResult: () => app.gwMetrics.idempotencyHitTotal.inc(),
    onMalformed: () => app.gwMetrics.idempotencyMalformedTotal.inc(),
    onRedisError: () => app.gwMetrics.redisErrorTotal.inc({ op: "idempotency" }),
    logger: app.log,
  });

  return {
    handled:
      result.outcome === "replayed" ||
      result.outcome === "conflict" ||
      result.outcome === "degraded",
    idemKey: result.idemKey,
  };
}
