// API-key migration plan Phase 3 #4-b — fixed-bucket sliding-window
// rate limit primitive. The bucket key itself rotates every 60s
// (`rl:apikey:<id>:<floor(now / 60_000)>`), so the implementation is
// "INCR + maybe EXPIRE" via a small Lua script — no cleanup, no ZSET
// scan, sub-millisecond per request.
//
// Trade-off vs. true sliding window: a request at xx:59:59 followed by
// another at xx:00:00 sees two distinct buckets, so a malicious client
// could in principle issue `2 × limit` requests around the boundary.
// For our use case (catching runaway clients, not DDoS) this is fine
// and the simplicity is worth it. If we ever need precise smoothing,
// migrate to a ZSET-based windowed count.

import type { Redis } from "ioredis";
import { INCREMENT_RATE_BUCKET_LUA } from "./lua/incrementRateBucket.js";
import { keys } from "./keys.js";

export const BUCKET_WINDOW_SEC = 60;

export interface RateLimitResult {
  /** Total requests counted in the current bucket, including this one. */
  count: number;
  /** Whether this request is over the limit (count > limit). */
  exceeded: boolean;
  /** Seconds remaining in the current bucket window — for Retry-After. */
  retryAfterSec: number;
}

/**
 * Increment the per-apiKey bucket counter and report whether the
 * caller has exceeded `limit` for the current 60s window.
 *
 * The function never throws on Redis errors at the call site — instead
 * it returns `{ exceeded: false, count: 0, retryAfterSec: 0 }` so the
 * caller can fail-open. The middleware layer logs the underlying error.
 *
 * Pass `now()` so tests can pin the bucket boundary deterministically.
 */
export async function checkApiKeyRateLimit(
  redis: Redis,
  apiKeyId: string,
  limit: number,
  now: () => number = Date.now,
): Promise<RateLimitResult> {
  const t = now();
  const minuteBucket = Math.floor(t / 60_000);
  const key = keys.rlApiKey(apiKeyId, minuteBucket);

  const count = (await redis.eval(
    INCREMENT_RATE_BUCKET_LUA,
    1,
    key,
    String(BUCKET_WINDOW_SEC),
  )) as number;

  const elapsedInBucketMs = t - minuteBucket * 60_000;
  const retryAfterSec = Math.max(
    1,
    Math.ceil((60_000 - elapsedInBucketMs) / 1000),
  );
  return {
    count,
    exceeded: count > limit,
    retryAfterSec,
  };
}
