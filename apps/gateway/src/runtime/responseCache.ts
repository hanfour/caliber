// API-key migration plan Phase 3 #2 — response cache.
//
// Cost-optimisation only: when an identical (org, platform, request
// body) tuple is asked twice within `GATEWAY_CACHE_TTL_SEC`, the second
// call returns the first call's response without dispatching upstream.
//
// Boundaries:
//   * Cache is keyed by SHA-256 of `(orgId, platform, body bytes)`. Org
//     prefix is the privacy boundary — cross-tenant hits are
//     impossible.
//   * Only cached: 200 responses with body < 64 KiB, non-streaming.
//   * Streaming requests skip the cache entirely (assuming
//     deterministic non-stream responses; SSE delta order is harder
//     to round-trip without behavioural changes).
//   * Disabled by default (`GATEWAY_CACHE_TTL_SEC=0`). When 0, all
//     cache helpers no-op and `tryCacheRead` returns null.
//
// What this module is NOT:
//   * NOT a way to reduce platform-side detection / fingerprinting.
//     The same key still hits OpenAI/Anthropic on first request and
//     all subsequent requests after TTL expiry. Caching's value is
//     cost + latency, period.
//
// What's stored in Redis:
//   * Key: `respcache:<sha256>`
//   * Value: JSON `{ status, headers, bodyBase64, cachedAt }`
//     (base64 because Redis values are byte-safe but we want a
//     stable JSON wire shape).
//
// Privacy posture:
//   * Cached payloads include the upstream response body, which
//     includes the model output but NOT the request prompt — only the
//     hash of the prompt is in the key.
//   * Admins enable cache at deploy-time via env. Per-org / per-group
//     opt-in lands in a follow-up PR after first-use feedback.

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export const CACHE_KEY_PREFIX = "respcache:";
export const MAX_CACHEABLE_BODY_BYTES = 64 * 1024; // 64 KiB

export interface CachedResponse {
  /** HTTP status — only 200 ever cached, but stored explicitly. */
  status: number;
  /**
   * Response headers worth replaying. Selective rather than wholesale —
   * see `cacheableResponseHeaders`. Storing all headers risks replaying
   * stale `x-request-id`, hop-by-hop, or upstream-only metadata.
   */
  headers: Record<string, string>;
  /** Response body, base64 to keep the JSON wire shape byte-safe. */
  bodyBase64: string;
  /** ms since epoch when this entry was written. */
  cachedAt: number;
}

/**
 * Stable response-hash function. Inputs MUST round-trip identically for
 * identical requests; in particular this includes the raw byte sequence
 * of the request body (post-buffering), so byte-noise from upstream
 * proxies / different client serialisers won't break cache hits.
 */
export function computeCacheKey(
  orgId: string,
  platform: string,
  bodyBytes: Buffer | string,
): string {
  const h = createHash("sha256");
  h.update(orgId);
  h.update(":");
  h.update(platform);
  h.update(":");
  h.update(typeof bodyBytes === "string" ? bodyBytes : bodyBytes);
  return CACHE_KEY_PREFIX + h.digest("hex");
}

/**
 * Headers worth replaying from a cached response. Excludes:
 *   - hop-by-hop (`connection`, `transfer-encoding`, `keep-alive`)
 *   - request-correlation (`x-request-id`)
 *   - body-size (`content-length` — Fastify recomputes)
 *   - vendor metadata that's per-call (`x-ratelimit-*` from upstream)
 */
const CACHEABLE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "anthropic-version",
  "openai-model",
]);

export function pickCacheableHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!CACHEABLE_HEADER_ALLOWLIST.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

export interface ResponseCacheDeps {
  redis: Pick<Redis, "get" | "set">;
  ttlSec: number;
  /**
   * Fired on a Redis op failure (the get/set is still swallowed and the
   * request falls through to upstream). The caller supplies an op-bound
   * emitter, e.g. `() => gwMetrics.redisErrorTotal.inc({ op: "cache_read" })`.
   */
  onRedisError?: () => void;
}

/**
 * Read a cached response. Returns null when:
 *   - caching is disabled (`ttlSec === 0`)
 *   - the key is missing
 *   - the stored value is corrupt / wrong-shape (logged at caller)
 *
 * Never throws — Redis errors return null so the request falls through
 * to the live upstream.
 */
export async function tryCacheRead(
  deps: ResponseCacheDeps,
  cacheKey: string,
): Promise<CachedResponse | null> {
  if (deps.ttlSec === 0) return null;
  let raw: string | null;
  try {
    raw = await deps.redis.get(cacheKey);
  } catch {
    deps.onRedisError?.();
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedResponse;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.status !== "number" ||
      typeof parsed.bodyBase64 !== "string" ||
      typeof parsed.cachedAt !== "number" ||
      typeof parsed.headers !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decide whether a fresh upstream response is cacheable, then store it.
 * Returns whether the store actually happened (false for ineligible
 * responses or disabled cache or Redis errors — all non-fatal).
 */
export async function maybeCacheStore(
  deps: ResponseCacheDeps,
  cacheKey: string,
  response: {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  },
  now: () => number = Date.now,
): Promise<boolean> {
  if (deps.ttlSec === 0) return false;
  if (response.status !== 200) return false;
  if (response.body.length > MAX_CACHEABLE_BODY_BYTES) return false;

  const payload: CachedResponse = {
    status: response.status,
    headers: pickCacheableHeaders(response.headers),
    bodyBase64: response.body.toString("base64"),
    cachedAt: now(),
  };
  try {
    await deps.redis.set(cacheKey, JSON.stringify(payload), "EX", deps.ttlSec);
    return true;
  } catch {
    deps.onRedisError?.();
    return false;
  }
}

/**
 * Route-level helper: check the cache, replay on hit, or set the
 * `x-cache: miss` header and return the cacheKey for the caller to
 * pass into a post-success store.
 *
 * Behaviour:
 *   - ttlSec === 0 → no-op, returns `{ hit: false, cacheKey: null }`.
 *     Caller proceeds to upstream; no `x-cache` header is emitted.
 *   - Cache hit → writes status / headers / body to `reply` (with
 *     `x-cache: hit`), returns `{ hit: true, cacheKey }`. Caller MUST
 *     return early without further reply emission.
 *   - Cache miss → sets `x-cache: miss` header on `reply` (preserved
 *     when the caller later sends the upstream response), returns
 *     `{ hit: false, cacheKey }`. Caller proceeds to upstream and
 *     calls `tryStoreOnSuccess(...)` after a successful response.
 *
 * Reply body: when hitting, this writes via `reply.send(body)`. The
 * caller's flow-control needs to bail out — typically `if (hit) return`.
 */
export interface CheckRouteCacheDeps {
  redis: Pick<Redis, "get" | "set">;
  ttlSec: number;
  orgId: string;
  scope: string;
  bodyBuf: Buffer;
  reply: {
    code(s: number): unknown;
    header(k: string, v: string): unknown;
    send(b: Buffer): unknown;
  };
  /**
   * Optional metric emitter — called once per check with `"hit"` or
   * `"miss"` when the cache is enabled (`ttlSec > 0`). Omit in tests
   * or when metrics aren't decorated yet. Disabled cache (`ttlSec=0`)
   * skips the callback entirely so disabled-mode doesn't pollute the
   * counter.
   */
  onResult?: (result: "hit" | "miss") => void;
  /** Forwarded to the read; e.g. `() => gwMetrics.redisErrorTotal.inc({ op: "cache_read" })`. */
  onRedisError?: () => void;
}

export interface CheckRouteCacheResult {
  hit: boolean;
  cacheKey: string | null;
}

export async function checkRouteCache(
  deps: CheckRouteCacheDeps,
): Promise<CheckRouteCacheResult> {
  if (deps.ttlSec === 0) {
    return { hit: false, cacheKey: null };
  }
  const cacheKey = computeCacheKey(deps.orgId, deps.scope, deps.bodyBuf);
  const cached = await tryCacheRead(
    { redis: deps.redis, ttlSec: deps.ttlSec, onRedisError: deps.onRedisError },
    cacheKey,
  );
  if (cached) {
    deps.reply.code(cached.status);
    for (const [k, v] of Object.entries(cached.headers)) {
      deps.reply.header(k, v);
    }
    deps.reply.header("x-cache", "hit");
    deps.reply.send(decodeCachedBody(cached));
    deps.onResult?.("hit");
    return { hit: true, cacheKey };
  }
  deps.reply.header("x-cache", "miss");
  deps.onResult?.("miss");
  return { hit: false, cacheKey };
}

/**
 * Fire-and-forget cache write. Caller invokes after a successful
 * upstream response has been emitted (or about to be); this never
 * blocks the user-visible path or throws — eligibility checks +
 * Redis errors are absorbed into a boolean return.
 */
export function tryStoreOnSuccess(
  deps: ResponseCacheDeps,
  cacheKey: string | null,
  response: {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  },
): void {
  if (cacheKey === null) return;
  void maybeCacheStore(deps, cacheKey, response);
}

/**
 * Decode a cached response body back to bytes for replay.
 */
export function decodeCachedBody(payload: CachedResponse): Buffer {
  return Buffer.from(payload.bodyBase64, "base64");
}
