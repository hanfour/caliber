import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { waitQueuePlugin } from "../../src/middleware/waitQueuePlugin.js";
import { keys } from "../../src/redis/keys.js";

interface FixtureKey {
  id: string;
  orgId: string;
  userId: string;
  teamId: string | null;
  groupId: string | null;
}

const KEY: FixtureKey = {
  id: "key-1",
  orgId: "org-1",
  userId: "user-1",
  teamId: null,
  groupId: null,
};

function fakeRedisPlugin(redis: Redis) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("redis", redis as any);
    },
    { name: "redisPlugin" },
  );
}

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

async function buildApp(opts: {
  apiKey: FixtureKey | null;
  maxWait: number;
  redis: Redis;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fakeRedisPlugin(opts.redis));
  await app.register(fakeApiKeyAuth(opts.apiKey));
  await app.register(waitQueuePlugin, {
    env: {
      GATEWAY_MAX_WAIT: opts.maxWait,
    } as unknown as Parameters<typeof waitQueuePlugin>[1]["env"],
  });
  app.get("/v1/test", async () => ({ ok: true }));
  return app;
}

/** Fill a user's wait ZSET so the next admission attempt sees a full queue. */
async function seedQueue(redis: Redis, userId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await redis.zadd(keys.wait(userId), Date.now() + i, `seed-${i}`);
  }
}

describe("waitQueuePlugin", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("admits a request when the user's queue is under the cap", async () => {
    const app = await buildApp({ apiKey: KEY, maxWait: 10, redis });
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("dequeues on response so sequential requests don't accumulate", async () => {
    const app = await buildApp({ apiKey: KEY, maxWait: 10, redis });
    await app.inject({ method: "GET", url: "/v1/test" });
    await app.inject({ method: "GET", url: "/v1/test" });
    // onResponse removed each entry → queue is empty again.
    expect(await redis.zcard(keys.wait(KEY.userId))).toBe(0);
    await app.close();
  });

  it("rejects with 429 wait_queue_full when the user's queue is at the cap", async () => {
    const app = await buildApp({ apiKey: KEY, maxWait: 3, redis });
    await seedQueue(redis, KEY.userId, 3);
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "wait_queue_full", maxWait: 3 });
    await app.close();
  });

  it("disabled (maxWait=0) never enqueues or rejects", async () => {
    const app = await buildApp({ apiKey: KEY, maxWait: 0, redis });
    await seedQueue(redis, KEY.userId, 100); // even a full queue is ignored
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    // No enqueue/dequeue happened — seeded entries untouched.
    expect(await redis.zcard(keys.wait(KEY.userId))).toBe(100);
    await app.close();
  });

  it("skips public paths (req.apiKey null)", async () => {
    const app = await buildApp({ apiKey: null, maxWait: 1, redis });
    await seedQueue(redis, KEY.userId, 5);
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("fails open (admits) when Redis errors on enqueue", async () => {
    // Redis whose eval rejects; zcard/zrem are harmless no-ops.
    const failing = {
      eval: () => Promise.reject(new Error("redis down")),
      zcard: () => Promise.resolve(0),
      zrem: () => Promise.resolve(0),
    } as unknown as Redis;
    const app = await buildApp({ apiKey: KEY, maxWait: 1, redis: failing });
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
