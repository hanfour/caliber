import type { Redis } from "ioredis";
import { keys } from "./keys.js";

// `gw_idempotency_hit_total` is emitted from `runtime/idempotencyCache.ts` (the
// route-level helper) on replay/conflict. `gw_idempotency_malformed_total`
// (design §4.9) is still deferred: `getCached` swallows a corrupt entry as a
// miss + logs, but doesn't yet surface a malformed signal to a counter — wire an
// `onMalformed` hook here + define the metric when that observability is wanted.

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

export async function setInFlight(
  redis: Redis,
  requestId: string,
  ttlSec: number,
): Promise<void> {
  const marker: InFlightMarker = { marker: "in_progress", startedAt: Date.now() };
  await redis.set(keys.idem(requestId), JSON.stringify(marker), "EX", ttlSec);
}

export function isInFlight(entry: IdempotencyEntry): entry is InFlightMarker {
  return (entry as InFlightMarker).marker === "in_progress";
}
