import type { Redis } from "ioredis";
import { keys } from "./keys.js";

// `gw_idempotency_hit_total` is emitted from `runtime/idempotencyCache.ts` (the
// route-level helper) on replay/conflict. `gw_idempotency_malformed_total`
// (design §4.9) is wired via the `onMalformed` hook below: `getCached` still
// swallows a corrupt entry as a miss + logs, and now also fires `onMalformed`
// so the helper can surface it to the counter.

export interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  // Discriminator: completed responses serialize without `marker`
  marker?: never;
}

export interface InFlightMarker {
  marker: "in_progress";
  startedAt: number; // epoch ms
}

export type IdempotencyEntry = CachedResponse | InFlightMarker;

export interface IdempotencyOptions {
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Fired when a stored entry fails to parse (still treated as a miss). */
  onMalformed?: () => void;
}

export async function getCached(
  redis: Redis,
  requestId: string,
  opts: IdempotencyOptions = {},
): Promise<IdempotencyEntry | null> {
  const raw = await redis.get(keys.idem(requestId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdempotencyEntry;
  } catch (err) {
    opts.logger?.warn(
      {
        requestId,
        raw: raw.slice(0, 200),
        err: err instanceof Error ? err.message : String(err),
      },
      "idempotency cache entry malformed; treating as miss",
    );
    opts.onMalformed?.();
    return null;
  }
}

export async function setCached(
  redis: Redis,
  requestId: string,
  response: CachedResponse,
  ttlSec: number,
): Promise<void> {
  await redis.set(keys.idem(requestId), JSON.stringify(response), "EX", ttlSec);
}

/**
 * Unconditionally write an in-flight marker. NOT used on the production claim
 * path — `claimInFlight` (atomic SET NX) replaced it to close the GET→SET
 * race. Retained as a test/seed helper for pre-populating an in-flight slot.
 */
export async function setInFlight(
  redis: Redis,
  requestId: string,
  ttlSec: number,
): Promise<void> {
  const marker: InFlightMarker = { marker: "in_progress", startedAt: Date.now() };
  await redis.set(keys.idem(requestId), JSON.stringify(marker), "EX", ttlSec);
}

/**
 * Atomically claim the in-flight slot. Returns true iff this caller set the
 * marker (the key did not already exist). A false return means a concurrent
 * request already claimed it OR a completed entry exists → the caller must
 * treat it as an in-flight conflict.
 *
 * This closes the GET→SET race that a plain `setInFlight` after `getCached`
 * leaves open: two same-id requests can both read a miss, but only one can win
 * the `SET ... NX`, so exactly one proceeds upstream (design §4.7 — avoid
 * double-charge).
 */
export async function claimInFlight(
  redis: Redis,
  requestId: string,
  ttlSec: number,
): Promise<boolean> {
  const marker: InFlightMarker = { marker: "in_progress", startedAt: Date.now() };
  const res = await redis.set(
    keys.idem(requestId),
    JSON.stringify(marker),
    "EX",
    ttlSec,
    "NX",
  );
  return res === "OK";
}

/**
 * Delete the in-flight slot so a same-id retry can re-dispatch upstream
 * (design §4.7). MUST only be called by the request that CLAIMED the slot
 * (the "proceed" path, idemKey != null) and only on a terminal non-2xx — a
 * 2xx is replaced by the completed cache entry via `setCached`, and a
 * duplicate that received 409 never owned the marker.
 */
export async function clearInFlight(
  redis: Redis,
  requestId: string,
): Promise<void> {
  await redis.del(keys.idem(requestId));
}

export function isInFlight(entry: IdempotencyEntry): entry is InFlightMarker {
  return (entry as InFlightMarker).marker === "in_progress";
}
