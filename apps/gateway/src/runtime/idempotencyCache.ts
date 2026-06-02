// Idempotency cache (design §4.5). Client-opt-in: only requests carrying an
// `X-Request-Id` header participate. Structurally parallel to responseCache.ts,
// but keyed by the client request id (not a content hash) and with an
// in-flight marker so a duplicate that arrives while the first is still running
// gets `409` instead of a partial replay.
//
//   - completed entry  → replay the cached response verbatim; caller returns.
//   - in-flight marker → `409 request_in_progress` + Retry-After; caller returns.
//   - miss             → write an in-flight marker, caller proceeds and stores
//                        the finished (non-stream, 200) response on success.
//
// Failure posture (design §4.7): fail-CLOSED in strict mode — a Redis error on
// the check becomes `503 service_degraded` rather than risking a double-charge
// on a retried request. In lenient mode the request proceeds without
// idempotency. Disabled entirely when `ttlSec === 0`.

import type { Redis } from "ioredis";
import {
  getCached,
  setCached,
  setInFlight,
  isInFlight,
  type CachedResponse,
} from "../redis/idempotency.js";

/** Headers worth replaying — same conservative allowlist as responseCache. */
const REPLAYABLE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "anthropic-version",
  "openai-model",
]);

function pickReplayableHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!REPLAYABLE_HEADER_ALLOWLIST.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

export interface ReplyLike {
  code(s: number): unknown;
  header(k: string, v: string): unknown;
  send(b: unknown): unknown;
}

export interface CheckIdempotencyDeps {
  redis: Redis;
  ttlSec: number;
  /** true when GATEWAY_REDIS_FAILURE_MODE === "strict". */
  failClosed: boolean;
  /** The client's `X-Request-Id`; null/empty disables idempotency for this request. */
  requestKey: string | null;
  /**
   * Tenant scope (the api_key_id) — composed into the Redis key as
   * `${scope}:${requestKey}` so two tenants using the same X-Request-Id never
   * collide. `scope` is a UUID (colon-free), so the `:` delimiter is an
   * unambiguous scope boundary even when X-Request-Id itself contains `:`.
   * The route helper guarantees a non-empty scope (it skips the check entirely
   * when no authenticated api key is present), hence `string`, not `string | null`.
   */
  scope: string;
  reply: ReplyLike;
  /** Per-check metric (`gw_idempotency_hit_total` on replay/conflict). */
  onResult?: (r: "replayed" | "conflict") => void;
  /** Fired when a stored entry fails to parse (`gw_idempotency_malformed_total`). */
  onMalformed?: () => void;
  /** Fired on a Redis op failure (`gw_redis_error_total{op="idempotency"}`). */
  onRedisError?: () => void;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export type IdempotencyOutcome =
  | "disabled" // not opted-in / ttl 0 — caller proceeds, no store
  | "replayed" // completed response was replayed — caller returns
  | "conflict" // duplicate in-flight, 409 sent — caller returns
  | "degraded" // strict-mode Redis failure, 503 sent — caller returns
  | "proceed"; // miss; in-flight marker set — caller proceeds and stores

export interface CheckIdempotencyResult {
  outcome: IdempotencyOutcome;
  /** Set only when outcome === "proceed" — pass to `storeIdempotent` on success. */
  idemKey: string | null;
}

export async function checkIdempotency(
  deps: CheckIdempotencyDeps,
): Promise<CheckIdempotencyResult> {
  if (deps.ttlSec === 0 || !deps.requestKey) {
    return { outcome: "disabled", idemKey: null };
  }
  const key = `${deps.scope}:${deps.requestKey}`;

  let entry;
  try {
    entry = await getCached(deps.redis, key, {
      logger: deps.logger,
      // surface malformed entries to the metric; getCached still treats them
      // as a miss (returns null), so a corrupt entry degrades to a fresh run.
      onMalformed: deps.onMalformed,
    });
  } catch (err) {
    return failure(deps, err);
  }

  if (entry && isInFlight(entry)) {
    deps.reply.code(409);
    deps.reply.header("retry-after", "1");
    deps.reply.send({ error: "request_in_progress", requestId: deps.requestKey });
    deps.onResult?.("conflict");
    return { outcome: "conflict", idemKey: null };
  }

  if (entry) {
    // completed CachedResponse
    deps.reply.code(entry.status);
    for (const [k, v] of Object.entries(entry.headers)) deps.reply.header(k, v);
    deps.reply.header("x-idempotent-replay", "true");
    deps.reply.send(Buffer.from(entry.body, "base64"));
    deps.onResult?.("replayed");
    return { outcome: "replayed", idemKey: null };
  }

  // miss — claim the slot with an in-flight marker so concurrent duplicates 409.
  try {
    await setInFlight(deps.redis, key, deps.ttlSec);
  } catch (err) {
    return failure(deps, err);
  }
  return { outcome: "proceed", idemKey: key };
}

function failure(
  deps: CheckIdempotencyDeps,
  err: unknown,
): CheckIdempotencyResult {
  deps.onRedisError?.();
  deps.logger?.warn(
    { err: err instanceof Error ? err.message : String(err) },
    "idempotency_check_failed",
  );
  if (deps.failClosed) {
    deps.reply.code(503);
    deps.reply.send({ error: "service_degraded" });
    return { outcome: "degraded", idemKey: null };
  }
  // lenient — proceed without idempotency (no marker, no store).
  return { outcome: "disabled", idemKey: null };
}

export interface StoreIdempotentDeps {
  redis: Redis;
  ttlSec: number;
}

/**
 * Fire-and-forget store of a finished response under the in-flight slot.
 * Only 200 non-stream responses are cached (streams keep their marker until it
 * expires — design §4.5 does not replay partial SSE). Never throws.
 */
export function storeIdempotent(
  deps: StoreIdempotentDeps,
  idemKey: string | null,
  response: {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  },
): void {
  if (idemKey === null) return;
  if (response.status !== 200) return;
  const payload: CachedResponse = {
    status: response.status,
    headers: pickReplayableHeaders(response.headers),
    body: response.body.toString("base64"),
  };
  void setCached(deps.redis, idemKey, payload, deps.ttlSec).catch(() => {
    // best-effort; the in-flight marker's TTL cleans up on its own.
  });
}
