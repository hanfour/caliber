import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  CACHE_KEY_PREFIX,
  MAX_CACHEABLE_BODY_BYTES,
  computeCacheKey,
  decodeCachedBody,
  maybeCacheStore,
  pickCacheableHeaders,
  tryCacheRead,
  type ResponseCacheDeps,
} from "../../src/runtime/responseCache.js";

const ORG = "org-uuid-1";
const PLAT = "openai";

describe("computeCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeCacheKey(ORG, PLAT, '{"model":"gpt-4o"}');
    const b = computeCacheKey(ORG, PLAT, '{"model":"gpt-4o"}');
    expect(a).toBe(b);
    expect(a.startsWith(CACHE_KEY_PREFIX)).toBe(true);
  });

  it("differs across orgs (privacy boundary)", () => {
    const a = computeCacheKey("org-A", PLAT, '{"x":1}');
    const b = computeCacheKey("org-B", PLAT, '{"x":1}');
    expect(a).not.toBe(b);
  });

  it("differs across platforms", () => {
    const a = computeCacheKey(ORG, "openai", '{"x":1}');
    const b = computeCacheKey(ORG, "anthropic", '{"x":1}');
    expect(a).not.toBe(b);
  });

  it("differs on byte-level body changes", () => {
    const a = computeCacheKey(ORG, PLAT, '{"x":1}');
    const b = computeCacheKey(ORG, PLAT, '{"x": 1}'); // extra space
    expect(a).not.toBe(b);
  });

  it("accepts both Buffer and string bodies and yields the same hash", () => {
    const s = '{"x":1}';
    const a = computeCacheKey(ORG, PLAT, s);
    const b = computeCacheKey(ORG, PLAT, Buffer.from(s));
    expect(a).toBe(b);
  });
});

describe("pickCacheableHeaders", () => {
  it("keeps only the allowlisted headers, lowercases keys", () => {
    const out = pickCacheableHeaders({
      "Content-Type": "application/json",
      "X-Request-Id": "should-be-stripped",
      "transfer-encoding": "chunked",
      "Anthropic-Version": "2023-06-01",
      "x-ratelimit-remaining": "should-be-stripped",
    });
    expect(out).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
  });

  it("flattens array values to comma-joined strings", () => {
    const out = pickCacheableHeaders({ "content-type": ["application/json"] });
    expect(out["content-type"]).toBe("application/json");
  });

  it("drops undefined values", () => {
    const out = pickCacheableHeaders({ "content-type": undefined });
    expect(out["content-type"]).toBeUndefined();
  });
});

describe("maybeCacheStore + tryCacheRead", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  function deps(ttlSec: number): ResponseCacheDeps {
    return { redis, ttlSec };
  }

  it("disabled (ttlSec=0): store no-ops, read returns null", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    const stored = await maybeCacheStore(deps(0), k, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}'),
    });
    expect(stored).toBe(false);
    const read = await tryCacheRead(deps(0), k);
    expect(read).toBeNull();
  });

  it("happy path: 200 response stored + retrieved roundtrip", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    const body = Buffer.from('{"id":"resp_123","output":[]}');
    const stored = await maybeCacheStore(deps(60), k, {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    });
    expect(stored).toBe(true);

    const read = await tryCacheRead(deps(60), k);
    expect(read).not.toBeNull();
    expect(read!.status).toBe(200);
    expect(read!.headers).toEqual({ "content-type": "application/json" });
    expect(decodeCachedBody(read!).toString("utf8")).toBe(body.toString("utf8"));
  });

  it("does NOT cache non-200 responses", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    for (const status of [400, 401, 429, 500, 502]) {
      const stored = await maybeCacheStore(deps(60), k, {
        status,
        headers: {},
        body: Buffer.from("err"),
      });
      expect(stored).toBe(false);
    }
    expect(await tryCacheRead(deps(60), k)).toBeNull();
  });

  it("does NOT cache bodies larger than the size limit", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    const big = Buffer.alloc(MAX_CACHEABLE_BODY_BYTES + 1, 0x61);
    const stored = await maybeCacheStore(deps(60), k, {
      status: 200,
      headers: {},
      body: big,
    });
    expect(stored).toBe(false);
  });

  it("caches a body exactly at the size boundary", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    const exactly = Buffer.alloc(MAX_CACHEABLE_BODY_BYTES, 0x62);
    const stored = await maybeCacheStore(deps(60), k, {
      status: 200,
      headers: {},
      body: exactly,
    });
    expect(stored).toBe(true);
  });

  it("returns null on corrupt cache values", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    await redis.set(k, "not-json-at-all", "EX", 60);
    expect(await tryCacheRead(deps(60), k)).toBeNull();
  });

  it("returns null on JSON-shaped but wrong-shape values", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    await redis.set(k, JSON.stringify({ status: "not a number" }), "EX", 60);
    expect(await tryCacheRead(deps(60), k)).toBeNull();
  });

  it("read swallows Redis errors, returns null, and fires onRedisError (fail-open)", async () => {
    const flaky: Pick<Redis, "get" | "set"> = {
      get: () => Promise.reject(new Error("redis_oom")),
      set: () => Promise.reject(new Error("redis_oom")),
    } as unknown as Pick<Redis, "get" | "set">;
    let redisErrors = 0;
    expect(
      await tryCacheRead(
        { redis: flaky, ttlSec: 60, onRedisError: () => (redisErrors += 1) },
        "respcache:whatever",
      ),
    ).toBeNull();
    expect(redisErrors).toBe(1);
  });

  it("store swallows Redis errors, reports false, and fires onRedisError", async () => {
    const flaky: Pick<Redis, "get" | "set"> = {
      get: () => Promise.reject(new Error("redis_oom")),
      set: () => Promise.reject(new Error("redis_oom")),
    } as unknown as Pick<Redis, "get" | "set">;
    let redisErrors = 0;
    const stored = await maybeCacheStore(
      { redis: flaky, ttlSec: 60, onRedisError: () => (redisErrors += 1) },
      "respcache:whatever",
      { status: 200, headers: {}, body: Buffer.from("x") },
    );
    expect(stored).toBe(false);
    expect(redisErrors).toBe(1);
  });

  it("uses the provided TTL — read after expiry returns null", async () => {
    const k = computeCacheKey(ORG, PLAT, "body");
    await maybeCacheStore(deps(60), k, {
      status: 200,
      headers: {},
      body: Buffer.from("x"),
    });
    // Force-expire (ioredis-mock supports EXPIRE).
    await redis.expire(k, 0);
    expect(await tryCacheRead(deps(60), k)).toBeNull();
  });
});
