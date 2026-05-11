import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { enqueueWait, dequeueWait } from "../../src/redis/waitQueue.js";

describe("waitQueue", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
  });

  afterEach(async () => {
    await redis.quit().catch(() => {});
  });

  it("enqueueWait under cap returns true and increments ZCARD", async () => {
    const ok = await enqueueWait(redis, "u1", "req-1", 5);
    expect(ok).toBe(true);
    expect(await redis.zcard("wait:user:u1")).toBe(1);
  });

  it("enqueueWait at cap returns false and does not increment ZCARD", async () => {
    await enqueueWait(redis, "u2", "req-1", 2);
    await enqueueWait(redis, "u2", "req-2", 2);
    const atCap = await enqueueWait(redis, "u2", "req-3", 2);
    expect(atCap).toBe(false);
    expect(await redis.zcard("wait:user:u2")).toBe(2);
  });

  it("dequeueWait removes the member", async () => {
    await enqueueWait(redis, "u3", "req-1", 5);
    expect(await redis.zcard("wait:user:u3")).toBe(1);
    await dequeueWait(redis, "u3", "req-1");
    expect(await redis.zcard("wait:user:u3")).toBe(0);
  });

  it("dequeueWait is a no-op for an unknown member", async () => {
    await expect(
      dequeueWait(redis, "u4", "never-enqueued"),
    ).resolves.toBeUndefined();
  });

  it("concurrent enqueues with maxWait=2 from 5 callers → exactly 2 succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        enqueueWait(redis, "u5", `req-${i}`, 2),
      ),
    );
    const succeeded = results.filter((r) => r).length;
    expect(succeeded).toBe(2);
    expect(await redis.zcard("wait:user:u5")).toBe(2);
  });

  it("enqueueWait sets EXPIRE 300 safety net on the key", async () => {
    await enqueueWait(redis, "u6", "req-1", 5);
    const ttl = await redis.ttl("wait:user:u6");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });
});
