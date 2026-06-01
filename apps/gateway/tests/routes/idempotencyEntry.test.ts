import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerEnv } from "@caliber/config";
import { checkRequestIdempotency } from "../../src/routes/idempotencyEntry.js";
import { setInFlight, setCached } from "../../src/redis/idempotency.js";

function fakeReply() {
  const calls = {
    status: 0 as number,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const reply = {
    calls,
    code(s: number) {
      calls.status = s;
      return reply;
    },
    header(k: string, v: string) {
      calls.headers[k] = v;
      return reply;
    },
    send(b: unknown) {
      calls.body = b;
      return reply;
    },
  };
  return reply;
}

interface Counters {
  hits: number;
  malformed: number;
  redisErrors: string[]; // op labels seen
}

function fakeApp(redis: Redis, c: Counters): FastifyInstance {
  return {
    redis,
    gwMetrics: {
      idempotencyHitTotal: { inc: () => (c.hits += 1) },
      idempotencyMalformedTotal: { inc: () => (c.malformed += 1) },
      redisErrorTotal: {
        inc: (labels: { op: string }) => c.redisErrors.push(labels.op),
      },
    },
    log: { warn: () => {} },
  } as unknown as FastifyInstance;
}

function counters(): Counters {
  return { hits: 0, malformed: 0, redisErrors: [] };
}

function fakeReq(xRequestId?: string | string[]): FastifyRequest {
  return {
    headers: xRequestId === undefined ? {} : { "x-request-id": xRequestId },
  } as unknown as FastifyRequest;
}

const strictEnv = {
  GATEWAY_IDEMPOTENCY_TTL_SEC: 300,
  GATEWAY_REDIS_FAILURE_MODE: "strict",
} as unknown as ServerEnv;

describe("checkRequestIdempotency", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("no X-Request-Id → not handled, no idemKey (disabled)", async () => {
    const c = counters();
    const res = await checkRequestIdempotency(
      fakeApp(redis, c),
      strictEnv,
      fakeReq(),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: false, idemKey: null });
    expect(c.hits).toBe(0);
  });

  it("miss → not handled, returns the in-flight idemKey to store on success", async () => {
    const res = await checkRequestIdempotency(
      fakeApp(redis, counters()),
      strictEnv,
      fakeReq("rid-miss"),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: false, idemKey: "rid-miss" });
  });

  it("in-flight duplicate → handled (409 sent) + metric incremented", async () => {
    await setInFlight(redis, "rid-dup", 300);
    const c = counters();
    const reply = fakeReply();
    const res = await checkRequestIdempotency(
      fakeApp(redis, c),
      strictEnv,
      fakeReq("rid-dup"),
      reply as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: true, idemKey: null });
    expect(reply.calls.status).toBe(409);
    expect(c.hits).toBe(1);
  });

  it("completed entry → handled (replay sent) + metric incremented", async () => {
    await setCached(
      redis,
      "rid-done",
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"ok":true}').toString("base64"),
      },
      300,
    );
    const c = counters();
    const reply = fakeReply();
    const res = await checkRequestIdempotency(
      fakeApp(redis, c),
      strictEnv,
      fakeReq("rid-done"),
      reply as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: true, idemKey: null });
    expect(reply.calls.headers["x-idempotent-replay"]).toBe("true");
    expect(c.hits).toBe(1);
  });

  it("array X-Request-Id → first element is used as the key", async () => {
    const res = await checkRequestIdempotency(
      fakeApp(redis, counters()),
      strictEnv,
      fakeReq(["rid-array-first", "rid-array-second"]),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res.idemKey).toBe("rid-array-first");
  });

  it("malformed stored entry → increments idempotencyMalformedTotal, proceeds as a miss", async () => {
    await redis.set("idem:rid-bad", "not json", "EX", 300);
    const c = counters();
    const res = await checkRequestIdempotency(
      fakeApp(redis, c),
      strictEnv,
      fakeReq("rid-bad"),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res.handled).toBe(false);
    expect(res.idemKey).toBe("rid-bad");
    expect(c.malformed).toBe(1);
  });

  it("Redis error (strict) → increments redisErrorTotal{op:idempotency}", async () => {
    const failing = {
      get: () => Promise.reject(new Error("down")),
    } as unknown as Redis;
    const c = counters();
    const reply = fakeReply();
    const res = await checkRequestIdempotency(
      fakeApp(failing, c),
      strictEnv,
      fakeReq("rid-err"),
      reply as unknown as FastifyReply,
    );
    expect(res.handled).toBe(true); // 503 degraded
    expect(reply.calls.status).toBe(503);
    expect(c.redisErrors).toEqual(["idempotency"]);
  });
});
