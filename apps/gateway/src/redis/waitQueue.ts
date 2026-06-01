import type { Redis } from "ioredis";
import { ENQUEUE_WAIT_LUA } from "./lua/enqueueWait.js";
import { keys } from "./keys.js";

// Admission control is wired via `middleware/waitQueuePlugin.ts` (a preHandler
// that enqueues + a onResponse hook that dequeues). The `gw_wait_queue_depth`
// gauge (design §4.9) is emitted there as a best-effort per-request sample.

/**
 * Atomically enqueues a request into a user's wait queue ZSET.
 *
 * Uses a Lua script to atomically:
 *   1. Check current queue depth (ZCARD)
 *   2. If depth >= maxWait, return false (fail-open per design 4.7)
 *   3. Otherwise ZADD and set a 300s safety EXPIRE, return true
 *
 * @param redis     - ioredis client (keyPrefix applied transparently)
 * @param userId    - User identifier (key becomes "wait:user:{userId}")
 * @param requestId - Unique identifier for this request
 * @param maxWait   - Maximum queue depth before rejecting new entries
 * @returns true if enqueued, false if queue is at capacity
 */
export async function enqueueWait(
  redis: Redis,
  userId: string,
  requestId: string,
  maxWait: number,
): Promise<boolean> {
  const result = (await redis.eval(
    ENQUEUE_WAIT_LUA,
    1,
    keys.wait(userId),
    String(Date.now()),
    requestId,
    String(maxWait),
  )) as number;
  return result === 1;
}

/**
 * Removes a request from the user's wait queue ZSET.
 *
 * Gracefully handles unknown members (ZREM returns 0 but does not throw).
 *
 * @param redis     - ioredis client
 * @param userId    - User identifier
 * @param requestId - The same requestId used during enqueueWait
 */
export async function dequeueWait(
  redis: Redis,
  userId: string,
  requestId: string,
): Promise<void> {
  await redis.zrem(keys.wait(userId), requestId);
}
