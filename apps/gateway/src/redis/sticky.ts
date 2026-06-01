import type { Redis } from "ioredis";
import { keys } from "./keys.js";

// TODO(part-7, blocked on part-6): emit gw_sticky_hit_total counter (design 4.9).
// Deferred: `getSticky`/`setSticky` have no callers yet (sticky-session routing
// isn't wired into the routes — see the part-6 TODO in messages.ts). NOTE: the
// Plan 5A `getRespSticky` path below is separate and already live via the scheduler.

export async function getSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
): Promise<string | null> {
  return await redis.get(keys.sticky(orgId, sessionId));
}

export async function setSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
  accountId: string,
  ttlSec: number,
): Promise<void> {
  await redis.set(keys.sticky(orgId, sessionId), accountId, "EX", ttlSec);
}

export async function deleteSticky(
  redis: Redis,
  orgId: string,
  sessionId: string,
): Promise<void> {
  await redis.del(keys.sticky(orgId, sessionId));
}

// Plan 5A §8.2 Layer 1 — previous_response_id sticky.
// TTL matches sub2api (1 hour); each lookup refreshes the TTL via SET EX.
export async function getRespSticky(
  redis: Redis,
  groupId: string,
  previousResponseId: string,
): Promise<string | null> {
  return await redis.get(keys.stickyResp(groupId, previousResponseId));
}

export async function setRespSticky(
  redis: Redis,
  groupId: string,
  previousResponseId: string,
  accountId: string,
  ttlSec = 60 * 60,
): Promise<void> {
  await redis.set(
    keys.stickyResp(groupId, previousResponseId),
    accountId,
    "EX",
    ttlSec,
  );
}

// Plan 5A §8.2 Layer 2 — session_hash sticky (TTL 30 min).
export async function getSessionSticky(
  redis: Redis,
  groupId: string,
  sessionHash: string,
): Promise<string | null> {
  return await redis.get(keys.stickySession(groupId, sessionHash));
}

export async function setSessionSticky(
  redis: Redis,
  groupId: string,
  sessionHash: string,
  accountId: string,
  ttlSec = 30 * 60,
): Promise<void> {
  await redis.set(
    keys.stickySession(groupId, sessionHash),
    accountId,
    "EX",
    ttlSec,
  );
}
