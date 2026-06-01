import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { rateLimitPlugin } from "../../src/middleware/rateLimitPlugin.js";

interface FixtureKey {
  id: string;
  orgId: string;
  userId: string;
  teamId: string | null;
  groupId: string | null;
  quotaUsd: string;
  quotaUsedUsd: string;
}

const KEY: FixtureKey = {
  id: "key-uuid-1",
  orgId: "org-1",
  userId: "user-1",
  teamId: null,
  groupId: null,
  quotaUsd: "100",
  quotaUsedUsd: "0",
};

/** Stand-in for `redisPlugin` so rateLimitPlugin can read fastify.redis. */
function fakeRedisPlugin(redis: Redis) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("redis", redis as any);
    },
    { name: "redisPlugin" },
  );
}

/** Stand-in for `apiKeyAuthPlugin` so the rate-limit plugin's dep resolves. */
function fakeApiKeyAuth(apiKey: FixtureKey | null) {
  return fp(
    async (fastify) => {
      fastify.decorateRequest("apiKey", null);
      fastify.addHook("preHandler", async (req) => {
        (req as unknown as { apiKey: FixtureKey | null }).apiKey = apiKey;
      });
    },
    { name: "apiKeyAuthPlugin" },
  );
}

interface BuildOpts {
  apiKey: FixtureKey | null;
  rpmLimit: number;
  redis?: Redis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gwMetrics?: any;
}

async function buildApp({
  apiKey,
  rpmLimit,
  redis,
  gwMetrics,
}: BuildOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const r =
    redis ??
    (() => {
      const mock = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
      return mock;
    })();
  await app.register(fakeRedisPlugin(r));
  if (gwMetrics) app.decorate("gwMetrics", gwMetrics);
  await app.register(fakeApiKeyAuth(apiKey));
  // Cast: rateLimitPlugin's options are a Partial<ServerEnv> shape; we
  // only need the rpmLimit knob to fire here.
  await app.register(rateLimitPlugin, {
    env: {
      GATEWAY_APIKEY_RPM_LIMIT: rpmLimit,
    } as unknown as Parameters<typeof rateLimitPlugin>[1]["env"],
  });
  app.get("/v1/test", async () => ({ ok: true }));
  return app;
}

describe("rateLimitPlugin", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("under limit: lets request through and exposes ratelimit headers", async () => {
    const app = await buildApp({ apiKey: KEY, rpmLimit: 10, redis });
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
    expect(res.headers["x-ratelimit-remaining"]).toBe("9");
    await app.close();
  });

  it("over limit: returns 429 with retry-after + json body", async () => {
    const app = await buildApp({ apiKey: KEY, rpmLimit: 2, redis });
    // Burn through the limit.
    await app.inject({ method: "GET", url: "/v1/test" });
    await app.inject({ method: "GET", url: "/v1/test" });
    // Third hits 429.
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    const body = res.json();
    expect(body).toMatchObject({
      error: "rate_limited",
      limit: 2,
      window: "60s",
    });
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("decrements remaining header as count climbs", async () => {
    const app = await buildApp({ apiKey: KEY, rpmLimit: 5, redis });
    const r1 = await app.inject({ method: "GET", url: "/v1/test" });
    const r2 = await app.inject({ method: "GET", url: "/v1/test" });
    const r3 = await app.inject({ method: "GET", url: "/v1/test" });
    expect(r1.headers["x-ratelimit-remaining"]).toBe("4");
    expect(r2.headers["x-ratelimit-remaining"]).toBe("3");
    expect(r3.headers["x-ratelimit-remaining"]).toBe("2");
    await app.close();
  });

  it("public path with null apiKey: skips the limit entirely", async () => {
    const app = await buildApp({ apiKey: null, rpmLimit: 1, redis });
    // Even with limit=1, 5 calls with apiKey=null all pass.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/test" });
      expect(res.statusCode).toBe(200);
      // No headers set since the plugin returned early.
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    }
    await app.close();
  });

  it("disabled (limit=0): no enforcement, no headers", async () => {
    const app = await buildApp({ apiKey: KEY, rpmLimit: 0, redis });
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/test" });
      expect(res.statusCode).toBe(200);
    }
    const last = await app.inject({ method: "GET", url: "/v1/test" });
    expect(last.headers["x-ratelimit-limit"]).toBeUndefined();
    await app.close();
  });

  it("isolates buckets per apiKey id", async () => {
    const app1 = await buildApp({
      apiKey: { ...KEY, id: "k1" },
      rpmLimit: 2,
      redis,
    });
    const app2 = await buildApp({
      apiKey: { ...KEY, id: "k2" },
      rpmLimit: 2,
      redis,
    });
    // Burn k1 to limit.
    await app1.inject({ method: "GET", url: "/v1/test" });
    await app1.inject({ method: "GET", url: "/v1/test" });
    const k1Over = await app1.inject({ method: "GET", url: "/v1/test" });
    expect(k1Over.statusCode).toBe(429);
    // k2 still has full headroom.
    const k2Fresh = await app2.inject({ method: "GET", url: "/v1/test" });
    expect(k2Fresh.statusCode).toBe(200);
    expect(k2Fresh.headers["x-ratelimit-remaining"]).toBe("1");
    await app1.close();
    await app2.close();
  });

  it("fails open when Redis throws — request goes through, no 429, emits metrics", async () => {
    // Deliberately use a redis stub whose eval rejects.
    const flakyRedis = {
      eval: () => Promise.reject(new Error("redis oom")),
    } as unknown as Redis;
    const failOpen: number[] = [];
    const redisErrors: string[] = [];
    const app = await buildApp({
      apiKey: KEY,
      rpmLimit: 1,
      redis: flakyRedis,
      gwMetrics: {
        gwRateLimitFailOpenTotal: { inc: () => failOpen.push(1) },
        redisErrorTotal: { inc: (l: { op: string }) => redisErrors.push(l.op) },
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(failOpen).toHaveLength(1);
    expect(redisErrors).toEqual(["rate_limit"]);
    await app.close();
  });
});
