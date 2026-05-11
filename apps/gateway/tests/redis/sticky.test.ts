import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  getSticky, setSticky, deleteSticky,
} from "../../src/redis/sticky.js";

describe("sticky", () => {
  let redis: Redis;
  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
  });
  afterEach(async () => { await redis.quit().catch(() => {}); });

  it("returns null when key absent", async () => {
    expect(await getSticky(redis, "org-a", "sess-1")).toBeNull();
  });

  it("round-trips accountId", async () => {
    await setSticky(redis, "org-a", "sess-1", "acct-x", 3600);
    expect(await getSticky(redis, "org-a", "sess-1")).toBe("acct-x");
  });

  it("respects ttlSec", async () => {
    await setSticky(redis, "org-a", "sess-1", "acct-x", 600);
    const ttl = await redis.ttl("sticky:org-a:sess-1");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("isolates two orgs with same sessionId", async () => {
    await setSticky(redis, "org-a", "shared-sess", "acct-from-a", 3600);
    await setSticky(redis, "org-b", "shared-sess", "acct-from-b", 3600);
    expect(await getSticky(redis, "org-a", "shared-sess")).toBe("acct-from-a");
    expect(await getSticky(redis, "org-b", "shared-sess")).toBe("acct-from-b");
  });

  it("deleteSticky removes entry", async () => {
    await setSticky(redis, "org-a", "sess-1", "acct-x", 3600);
    await deleteSticky(redis, "org-a", "sess-1");
    expect(await getSticky(redis, "org-a", "sess-1")).toBeNull();
  });

  it("setSticky overwrites prior value", async () => {
    await setSticky(redis, "org-a", "sess-1", "acct-old", 3600);
    await setSticky(redis, "org-a", "sess-1", "acct-new", 3600);
    expect(await getSticky(redis, "org-a", "sess-1")).toBe("acct-new");
  });
});
