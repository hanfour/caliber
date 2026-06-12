import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  getCached, setCached, setInFlight, isInFlight,
  claimInFlight, clearInFlight,
  type IdempotencyEntry,
} from "../../src/redis/idempotency.js";

describe("idempotency", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
  });

  afterEach(async () => {
    await redis.quit().catch(() => {});
  });

  it("getCached returns null when key absent", async () => {
    expect(await getCached(redis, "missing")).toBeNull();
  });

  it("round-trips a CachedResponse", async () => {
    await setCached(redis, "req-1", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }, 300);
    const got = await getCached(redis, "req-1");
    expect(got).toMatchObject({ status: 200, body: '{"ok":true}' });
  });

  it("setInFlight + getCached returns marker; isInFlight narrows", async () => {
    await setInFlight(redis, "req-2", 300);
    const got = await getCached(redis, "req-2");
    expect(got).not.toBeNull();
    expect(isInFlight(got as IdempotencyEntry)).toBe(true);
    if (got && isInFlight(got)) {
      expect(typeof got.startedAt).toBe("number");
    }
  });

  it("malformed JSON returns null and calls logger.warn when logger provided", async () => {
    const warn = vi.fn();
    await redis.set("idem:bad", "this is not json", "EX", 60);
    const result = await getCached(redis, "bad", { logger: { warn } });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "bad" }),
      "idempotency cache entry malformed; treating as miss",
    );
  });

  it("malformed JSON returns null without throwing when no logger provided", async () => {
    await redis.set("idem:bad-nolog", "this is not json", "EX", 60);
    await expect(getCached(redis, "bad-nolog")).resolves.toBeNull();
  });

  it("malformed JSON fires onMalformed (treated as a miss)", async () => {
    await redis.set("idem:bad-hook", "}{ not json", "EX", 60);
    let malformed = 0;
    const got = await getCached(redis, "bad-hook", {
      onMalformed: () => (malformed += 1),
    });
    expect(got).toBeNull();
    expect(malformed).toBe(1);
  });

  it("a well-formed entry does NOT fire onMalformed", async () => {
    await setCached(redis, "ok-hook", { status: 200, headers: {}, body: "" }, 60);
    let malformed = 0;
    await getCached(redis, "ok-hook", { onMalformed: () => (malformed += 1) });
    expect(malformed).toBe(0);
  });

  it("setCached respects ttlSec", async () => {
    await setCached(redis, "req-3", { status: 200, headers: {}, body: "" }, 120);
    const ttl = await redis.ttl("idem:req-3");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("setInFlight respects ttlSec", async () => {
    await setInFlight(redis, "req-4", 60);
    const ttl = await redis.ttl("idem:req-4");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("setCached overwrites prior setInFlight", async () => {
    await setInFlight(redis, "req-5", 300);
    await setCached(redis, "req-5", { status: 201, headers: {}, body: "ok" }, 300);
    const got = await getCached(redis, "req-5");
    expect(got).not.toBeNull();
    expect(isInFlight(got!)).toBe(false);
    expect(got).toMatchObject({ status: 201 });
  });

  // Fix A — atomic claim (SET NX EX). The first caller wins the slot; any
  // concurrent caller for the same id loses (false) and must treat it as an
  // in-flight conflict. This closes the GET→SET race in checkIdempotency.
  it("claimInFlight returns true exactly once for a key (NX semantics)", async () => {
    expect(await claimInFlight(redis, "req-claim", 300)).toBe(true);
    expect(await claimInFlight(redis, "req-claim", 300)).toBe(false);
    expect(await claimInFlight(redis, "req-claim", 300)).toBe(false);
  });

  it("claimInFlight writes an in-flight marker readable by getCached/isInFlight", async () => {
    await claimInFlight(redis, "req-claim-2", 300);
    const got = await getCached(redis, "req-claim-2");
    expect(got).not.toBeNull();
    expect(isInFlight(got as IdempotencyEntry)).toBe(true);
  });

  it("claimInFlight returns false when a COMPLETED entry already exists", async () => {
    await setCached(redis, "req-claim-3", { status: 200, headers: {}, body: "" }, 300);
    expect(await claimInFlight(redis, "req-claim-3", 300)).toBe(false);
  });

  it("claimInFlight respects ttlSec", async () => {
    await claimInFlight(redis, "req-claim-4", 60);
    const ttl = await redis.ttl("idem:req-claim-4");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  // Fix B — release the slot so a same-id retry can re-dispatch after a failure.
  it("clearInFlight deletes the slot so a subsequent claimInFlight wins again", async () => {
    expect(await claimInFlight(redis, "req-release", 300)).toBe(true);
    await clearInFlight(redis, "req-release");
    expect(await getCached(redis, "req-release")).toBeNull();
    expect(await claimInFlight(redis, "req-release", 300)).toBe(true);
  });

  it("clearInFlight on an absent key is a no-op (never throws)", async () => {
    await expect(clearInFlight(redis, "req-absent")).resolves.toBeUndefined();
  });
});
