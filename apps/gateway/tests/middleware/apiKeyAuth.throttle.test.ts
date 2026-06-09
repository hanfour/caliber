import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { hashApiKey } from "@caliber/gateway-core";
import { apiKeyAuthPlugin } from "../../src/middleware/apiKeyAuth.js";

const PEPPER = "a".repeat(64);
const RAW_KEY = "ak_throttletest12345";
const KEY_HASH = hashApiKey(PEPPER, RAW_KEY);

const BASE_FIXTURE = {
  apiKey: {
    id: "key-throttle-1",
    orgId: "org-1",
    userId: "user-1",
    teamId: null,
    groupId: null,
    keyHash: KEY_HASH,
    revokedAt: null,
    expiresAt: null,
    revealTokenHash: null,
    revealedAt: null,
    ipWhitelist: null,
    ipBlacklist: null,
    quotaUsd: "100.00000000",
    quotaUsedUsd: "0.00000000",
    routingPolicy: "pool",
  },
  user: { id: "user-1", email: "u@example.com" },
  org: {
    id: "org-1",
    slug: "acme",
    contentCaptureEnabled: false,
    retentionDaysOverride: null,
  },
};

function makeMockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "innerJoin", "where", "limit"];
  for (const m of methods) {
    chain[m] = (chain[m] = {
      then: undefined,
    } as unknown);
    // Reset to a fresh chain per build
  }
  const c: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where", "limit"]) {
    c[m] = () => c;
  }
  // limit returns a thenable so `.then(r => r[0])` works
  (c as Record<string, unknown>)["limit"] = () => Promise.resolve(rows);
  return c;
}

function fakeDbPlugin(mockDb: unknown) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("db", mockDb as any);
    },
    { name: "dbPlugin" },
  );
}

function fakeRedisPlugin(redis: Redis) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("redis", redis as any);
    },
    { name: "redisPlugin" },
  );
}

interface BuildOpts {
  rows: unknown[];
  redis: Redis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gwMetrics?: any;
  authFailMax?: number;
  authFailWindowSec?: number;
  authFailBlockSec?: number;
}

async function buildTestApp({
  rows,
  redis,
  gwMetrics,
  authFailMax = 3,
  authFailWindowSec = 60,
  authFailBlockSec = 120,
}: BuildOpts) {
  const app = Fastify({ logger: false });
  const mockDb = makeMockDb(rows);
  await app.register(fakeDbPlugin(mockDb));
  await app.register(fakeRedisPlugin(redis));
  if (gwMetrics) app.decorate("gwMetrics", gwMetrics);

  await app.register(apiKeyAuthPlugin, {
    env: {
      API_KEY_HASH_PEPPER: PEPPER,
      GATEWAY_AUTH_FAIL_MAX: authFailMax,
      GATEWAY_AUTH_FAIL_WINDOW_SEC: authFailWindowSec,
      GATEWAY_AUTH_FAIL_BLOCK_SEC: authFailBlockSec,
      GATEWAY_TRUSTED_PROXIES: "",
    } as never,
  });

  app.get("/echo", async (req) => {
    return { id: (req as never as { apiKey: { id: string } }).apiKey?.id };
  });

  return app;
}

describe("apiKeyAuth per-IP throttle", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("1. same IP sends invalid key MAX times → next invalid returns 429 with retry-after", async () => {
    const app = await buildTestApp({ rows: [], redis, authFailMax: 3 });

    // First 3 failures — these should each return 401 (not yet blocked)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/echo",
        headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
      });
      // The 3rd one may just-block and return 429 immediately
      if (i < 2) {
        expect(res.statusCode).toBe(401);
      }
    }

    // After MAX failures, next request should be 429
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.json()).toMatchObject({ error: "rate_limited" });

    await app.close();
  });

  it("2. INV-P1: valid key from same IP still returns 200 even after threshold is hit", async () => {
    const app = await buildTestApp({ rows: [], redis, authFailMax: 3 });

    // Exhaust threshold with invalid keys
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "GET",
        url: "/echo",
        headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
      });
    }

    // Confirm IP is blocked for invalid keys
    const blockedRes = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
    });
    expect(blockedRes.statusCode).toBe(429);

    // Now close this app and build a new one that has the VALID key in the DB
    await app.close();

    const app2 = await buildTestApp({
      rows: [BASE_FIXTURE],
      redis, // same redis — IP is still blocked
      authFailMax: 3,
    });

    // Valid key from the SAME IP must succeed — valid keys are NEVER throttled
    const validRes = await app2.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.json()).toMatchObject({ id: "key-throttle-1" });

    await app2.close();
  });

  it("3. missing key counts toward throttle (no DB hit needed)", async () => {
    const app = await buildTestApp({ rows: [], redis, authFailMax: 3 });

    // missing_api_key failures should also count toward the IP throttle
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/echo" });
    }

    // After MAX missing-key attempts, next attempt returns 429
    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "rate_limited" });

    await app.close();
  });

  it("4. Redis failure → invalid key still returns 401, not 429 (fail-open)", async () => {
    // Inject a redis that always rejects
    const brokenRedis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    // Override ttl and incr to reject
    (brokenRedis as unknown as Record<string, unknown>).ttl = () =>
      Promise.reject(new Error("redis down"));
    (brokenRedis as unknown as Record<string, unknown>).incr = () =>
      Promise.reject(new Error("redis down"));

    const app = await buildTestApp({
      rows: [],
      redis: brokenRedis,
      authFailMax: 3,
    });

    // Despite Redis failures, auth errors must still return the original 401
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_invalid" });

    await app.close();
  });

  it("5. gwMetrics.gwAuthFailThrottleTotal is incremented when IP is blocked", async () => {
    let throttleCount = 0;
    const gwMetrics = {
      gwAuthFailThrottleTotal: {
        inc: () => {
          throttleCount++;
        },
      },
      redisErrorTotal: { inc: () => {} },
    };

    const app = await buildTestApp({ rows: [], redis, authFailMax: 3, gwMetrics });

    // Generate enough failures to trigger block
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "GET",
        url: "/echo",
        headers: { authorization: "Bearer ak_invalid_key_xxxxxxx" },
      });
    }

    // The Nth request that just-blocked should have incremented gwAuthFailThrottleTotal
    expect(throttleCount).toBeGreaterThanOrEqual(1);

    await app.close();
  });
});
