import type { Redis } from "ioredis";
import { ACQUIRE_SLOT_LUA } from "./lua/acquireSlot.js";
import { keys } from "./keys.js";

// TODO(perf): migrate from EVAL to defineCommand+EVALSHA when call rate warrants

/**
 * Minimal structural shape of the `gw_slot_acquire_total` counter, kept
 * local so this Redis primitive stays decoupled from prom-client / the
 * fastify metrics plugin. `fastify.gwMetrics.slotAcquireTotal` satisfies it.
 */
export interface SlotAcquireMetric {
  inc(labels: {
    scope: "user" | "account";
    result: "ok" | "over_limit" | "redis_error";
  }): void;
}

/**
 * Atomically acquires a slot in a Redis ZSET rate-limiting bucket.
 *
 * Uses a Lua script to:
 *   1. Remove expired members (score <= now_ms)
 *   2. Check if current live member count >= limit
 *   3. If under limit, add (expiry_ms, requestId) and set a 300s safety EXPIRE
 *
 * @param redis     - ioredis client (keyPrefix is applied transparently)
 * @param scope     - Slot scope: "user" or "account" (design 4.1)
 * @param id        - User or account identifier
 * @param requestId - Unique identifier for this request/slot
 * @param limit     - Maximum number of concurrent slots allowed
 * @param durationMs - How long (ms) this slot is valid for
 * @param metric    - Optional `gw_slot_acquire_total` counter (design 4.9).
 *   Emits {scope, result=ok|over_limit|redis_error}. On a Redis error the
 *   `redis_error` result is counted and the error is re-thrown unchanged.
 * @returns true if the slot was acquired, false if at capacity
 */
export async function acquireSlot(
  redis: Redis,
  scope: "user" | "account",
  id: string,
  requestId: string,
  limit: number,
  durationMs: number,
  metric?: SlotAcquireMetric,
): Promise<boolean> {
  const key = keys.slots(scope, id);
  const now = Date.now();
  try {
    const result = (await redis.eval(
      ACQUIRE_SLOT_LUA,
      1,
      key,
      String(now),
      String(durationMs),
      requestId,
      String(limit),
    )) as number;
    const acquired = result === 1;
    metric?.inc({ scope, result: acquired ? "ok" : "over_limit" });
    return acquired;
  } catch (err) {
    metric?.inc({ scope, result: "redis_error" });
    throw err;
  }
}

/**
 * Releases a previously acquired slot by removing the member from the ZSET.
 *
 * This is not atomically paired with acquire — in the worst case, the expiry
 * score cleans up stale members on the next acquire call.
 *
 * @param redis     - ioredis client
 * @param scope     - Slot scope: "user" or "account" (design 4.1)
 * @param id        - User or account identifier
 * @param requestId - The same requestId used during acquireSlot
 */
export async function releaseSlot(
  redis: Redis,
  scope: "user" | "account",
  id: string,
  requestId: string,
): Promise<void> {
  await redis.zrem(keys.slots(scope, id), requestId);
}
