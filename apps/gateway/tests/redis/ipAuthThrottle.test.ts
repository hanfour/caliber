import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { checkIpBlocked, recordAuthFailure } from "../../src/redis/ipAuthThrottle.js";

const CFG = { max: 3, windowSec: 60, blockSec: 120 };

describe("ipAuthThrottle", () => {
  let redis: any;
  beforeEach(() => { redis = new RedisMock(); });

  it("not blocked before threshold", async () => {
    await recordAuthFailure(redis, "1.1.1.1", CFG);
    await recordAuthFailure(redis, "1.1.1.1", CFG);
    expect((await checkIpBlocked(redis, "1.1.1.1")).blocked).toBe(false);
  });

  it("blocks at threshold and reports retryAfterSec", async () => {
    let r;
    for (let i = 0; i < CFG.max; i++) r = await recordAuthFailure(redis, "2.2.2.2", CFG);
    expect(r!.justBlocked).toBe(true);
    const c = await checkIpBlocked(redis, "2.2.2.2");
    expect(c.blocked).toBe(true);
    expect(c.retryAfterSec).toBeGreaterThan(0);
    expect(c.retryAfterSec).toBeLessThanOrEqual(CFG.blockSec);
  });

  it("max=0 disables (never blocks)", async () => {
    const r = await recordAuthFailure(redis, "3.3.3.3", { ...CFG, max: 0 });
    expect(r.justBlocked).toBe(false);
    expect((await checkIpBlocked(redis, "3.3.3.3")).blocked).toBe(false);
  });

  it("distinct IPs counted separately", async () => {
    for (let i = 0; i < CFG.max; i++) await recordAuthFailure(redis, "4.4.4.4", CFG);
    expect((await checkIpBlocked(redis, "5.5.5.5")).blocked).toBe(false);
  });

  it("counter always carries a TTL (no stranded TTL-less key)", async () => {
    await recordAuthFailure(redis, "6.6.6.6", CFG);
    const ttl = await redis.ttl("auth-fail:6.6.6.6");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CFG.windowSec);
  });

  it("clears the fail counter when it sets the block (no stale re-block)", async () => {
    for (let i = 0; i < CFG.max; i++) await recordAuthFailure(redis, "7.7.7.7", CFG);
    expect(await redis.get("auth-fail:7.7.7.7")).toBeNull();
    // a fresh failure after the counter was cleared starts a new window at 1
    await recordAuthFailure(redis, "7.7.7.7", CFG);
    expect(await redis.get("auth-fail:7.7.7.7")).toBe("1");
  });
});
