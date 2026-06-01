import type { Redis } from "ioredis";
import { keys } from "./keys.js";

// Sticky-session routing is observed via the scheduler's own metrics
// (`gw_scheduler_sticky_hit_ratio` / `gw_scheduler_select_total{layer}`), which
// supersede the 4A-design `gw_sticky_hit_total` counter. The Layer 1/2 readers
// and writers below are the live path, wired from the routes via `runFailover`'s
// `previousResponseId` / `sessionHash` inputs. (The old 4A `getSticky`/`setSticky`
// org/session-id helpers were removed — superseded by the group-scoped variants.)

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
