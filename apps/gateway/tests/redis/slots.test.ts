import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { acquireSlot, releaseSlot } from "../../src/redis/slots.js";

describe("slots", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
  });

  afterEach(async () => {
    await redis.quit().catch(() => {});
  });

  it("first N concurrent acquires under limit succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        acquireSlot(redis, "user", "u1", `req-${i}`, 3, 60_000),
      ),
    );
    const ok = results.filter((r) => r).length;
    expect(ok).toBe(3);
  });

  it("releaseSlot frees the slot for a new acquire", async () => {
    await acquireSlot(redis, "user", "u2", "req-a", 1, 60_000);
    const blocked = await acquireSlot(redis, "user", "u2", "req-b", 1, 60_000);
    expect(blocked).toBe(false);
    await releaseSlot(redis, "user", "u2", "req-a");
    const allowed = await acquireSlot(redis, "user", "u2", "req-c", 1, 60_000);
    expect(allowed).toBe(true);
  });

  it("expired slots are cleaned up on next acquire", async () => {
    // Acquire with 1ms duration (immediately expires)
    await acquireSlot(redis, "user", "u3", "req-stale", 1, 1);
    await new Promise((r) => setTimeout(r, 10));
    const allowed = await acquireSlot(redis, "user", "u3", "req-fresh", 1, 60_000);
    expect(allowed).toBe(true);
  });

  it("acquire returns false when at limit", async () => {
    const r1 = await acquireSlot(redis, "user", "u4", "req-1", 1, 60_000);
    const r2 = await acquireSlot(redis, "user", "u4", "req-2", 1, 60_000);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
  });

  it("safety-net EXPIRE is set on the key", async () => {
    await acquireSlot(redis, "user", "u5", "req-1", 1, 60_000);
    // ioredis-mock supports TTL inspection; keyPrefix is applied transparently
    const ttl = await redis.ttl("slots:user:u5");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("releaseSlot is a no-op for unknown member", async () => {
    await expect(
      releaseSlot(redis, "user", "u6", "never-acquired"),
    ).resolves.toBeUndefined();
  });

  it("inline Lua script is embedded as a string constant (no fs read at module load)", async () => {
    const mod = await import("../../src/redis/lua/acquireSlot.js");
    expect(typeof mod.ACQUIRE_SLOT_LUA).toBe("string");
    expect(mod.ACQUIRE_SLOT_LUA).toContain("ZREMRANGEBYSCORE");
    expect(mod.ACQUIRE_SLOT_LUA).toContain("ZADD");
  });

  it("account scope acquires independently from user scope", async () => {
    const userOk = await acquireSlot(redis, "user", "shared-id", "req-u", 1, 60_000);
    const acctOk = await acquireSlot(redis, "account", "shared-id", "req-a", 1, 60_000);
    expect(userOk).toBe(true);
    expect(acctOk).toBe(true);
  });
});
