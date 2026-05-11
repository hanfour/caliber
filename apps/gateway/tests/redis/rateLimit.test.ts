import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  checkApiKeyRateLimit,
  BUCKET_WINDOW_SEC,
} from "../../src/redis/rateLimit.js";
import { keys } from "../../src/redis/keys.js";

const KEY_ID = "key-uuid-1";

describe("checkApiKeyRateLimit", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    // ioredis-mock instances share an underlying in-memory store by
    // default; flush between tests so counters from one test don't
    // leak into another's bucket.
    await redis.flushall();
  });

  it("returns count=1 + not-exceeded on first call inside the window", async () => {
    const result = await checkApiKeyRateLimit(redis, KEY_ID, 10, () => 0);
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it("increments monotonically across calls in the same bucket", async () => {
    const fixedNow = () => 0;
    const r1 = await checkApiKeyRateLimit(redis, KEY_ID, 10, fixedNow);
    const r2 = await checkApiKeyRateLimit(redis, KEY_ID, 10, fixedNow);
    const r3 = await checkApiKeyRateLimit(redis, KEY_ID, 10, fixedNow);
    expect([r1.count, r2.count, r3.count]).toEqual([1, 2, 3]);
    expect(r3.exceeded).toBe(false);
  });

  it("flips exceeded once count crosses limit", async () => {
    const fixedNow = () => 0;
    let last = await checkApiKeyRateLimit(redis, KEY_ID, 3, fixedNow);
    expect(last.exceeded).toBe(false);
    last = await checkApiKeyRateLimit(redis, KEY_ID, 3, fixedNow);
    last = await checkApiKeyRateLimit(redis, KEY_ID, 3, fixedNow);
    expect(last.count).toBe(3);
    expect(last.exceeded).toBe(false);
    last = await checkApiKeyRateLimit(redis, KEY_ID, 3, fixedNow);
    expect(last.count).toBe(4);
    expect(last.exceeded).toBe(true);
  });

  it("rotates bucket key on minute boundary — count resets", async () => {
    let nowMs = 0;
    const now = () => nowMs;
    const r1 = await checkApiKeyRateLimit(redis, KEY_ID, 5, now);
    expect(r1.count).toBe(1);

    // Same bucket, several increments.
    nowMs = 30_000;
    await checkApiKeyRateLimit(redis, KEY_ID, 5, now);
    await checkApiKeyRateLimit(redis, KEY_ID, 5, now);

    // Cross the minute boundary — bucket index changes.
    nowMs = 60_000;
    const r4 = await checkApiKeyRateLimit(redis, KEY_ID, 5, now);
    expect(r4.count).toBe(1); // fresh bucket
    expect(r4.exceeded).toBe(false);
  });

  it("retryAfterSec reflects time remaining in the current bucket", async () => {
    // 5 seconds into the minute → 55 seconds left.
    const result = await checkApiKeyRateLimit(redis, KEY_ID, 10, () => 5_000);
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(54);
    expect(result.retryAfterSec).toBeLessThanOrEqual(55);
  });

  it("retryAfterSec is at least 1 second even at the bucket boundary", async () => {
    // Right at xx:59.999 → ceil(0.001 / 1000) = 1.
    const result = await checkApiKeyRateLimit(redis, KEY_ID, 10, () => 59_999);
    expect(result.retryAfterSec).toBe(1);
  });

  it("isolates counters per apiKey id", async () => {
    const fixedNow = () => 0;
    await checkApiKeyRateLimit(redis, "key-a", 5, fixedNow);
    await checkApiKeyRateLimit(redis, "key-a", 5, fixedNow);
    const otherKey = await checkApiKeyRateLimit(redis, "key-b", 5, fixedNow);
    expect(otherKey.count).toBe(1);
  });

  it("sets a TTL on the bucket key (~60s) so abandoned buckets self-clean", async () => {
    const fixedNow = () => 0;
    await checkApiKeyRateLimit(redis, KEY_ID, 5, fixedNow);
    // 0 / 60_000 = 0
    const ttl = await redis.ttl(keys.rlApiKey(KEY_ID, 0));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(BUCKET_WINDOW_SEC);
  });
});
