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

function fakeApp(redis: Redis, hits: { n: number }): FastifyInstance {
  return {
    redis,
    gwMetrics: {
      idempotencyHitTotal: {
        inc: () => {
          hits.n += 1;
        },
      },
    },
    log: { warn: () => {} },
  } as unknown as FastifyInstance;
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
    const hits = { n: 0 };
    const res = await checkRequestIdempotency(
      fakeApp(redis, hits),
      strictEnv,
      fakeReq(),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: false, idemKey: null });
    expect(hits.n).toBe(0);
  });

  it("miss → not handled, returns the in-flight idemKey to store on success", async () => {
    const res = await checkRequestIdempotency(
      fakeApp(redis, { n: 0 }),
      strictEnv,
      fakeReq("rid-miss"),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: false, idemKey: "rid-miss" });
  });

  it("in-flight duplicate → handled (409 sent) + metric incremented", async () => {
    await setInFlight(redis, "rid-dup", 300);
    const hits = { n: 0 };
    const reply = fakeReply();
    const res = await checkRequestIdempotency(
      fakeApp(redis, hits),
      strictEnv,
      fakeReq("rid-dup"),
      reply as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: true, idemKey: null });
    expect(reply.calls.status).toBe(409);
    expect(hits.n).toBe(1);
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
    const hits = { n: 0 };
    const reply = fakeReply();
    const res = await checkRequestIdempotency(
      fakeApp(redis, hits),
      strictEnv,
      fakeReq("rid-done"),
      reply as unknown as FastifyReply,
    );
    expect(res).toEqual({ handled: true, idemKey: null });
    expect(reply.calls.headers["x-idempotent-replay"]).toBe("true");
    expect(hits.n).toBe(1);
  });

  it("array X-Request-Id → first element is used as the key", async () => {
    const res = await checkRequestIdempotency(
      fakeApp(redis, { n: 0 }),
      strictEnv,
      fakeReq(["rid-array-first", "rid-array-second"]),
      fakeReply() as unknown as FastifyReply,
    );
    expect(res.idemKey).toBe("rid-array-first");
  });
});
