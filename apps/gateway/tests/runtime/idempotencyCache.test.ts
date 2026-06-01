import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  checkIdempotency,
  storeIdempotent,
} from "../../src/runtime/idempotencyCache.js";
import {
  getCached,
  setCached,
  setInFlight,
} from "../../src/redis/idempotency.js";

function fakeReply() {
  const calls = { status: 0 as number, headers: {} as Record<string, string>, body: undefined as unknown };
  return {
    calls,
    code(s: number) { calls.status = s; return this; },
    header(k: string, v: string) { calls.headers[k] = v; return this; },
    send(b: unknown) { calls.body = b; return this; },
  };
}

describe("checkIdempotency", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("disabled when ttlSec=0 or no requestKey (no Redis touch)", async () => {
    const r1 = await checkIdempotency({ redis, ttlSec: 0, failClosed: true, requestKey: "rid", reply: fakeReply() });
    expect(r1.outcome).toBe("disabled");
    const r2 = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, requestKey: null, reply: fakeReply() });
    expect(r2.outcome).toBe("disabled");
  });

  it("miss → writes an in-flight marker and returns proceed + idemKey", async () => {
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, requestKey: "rid-1", reply: fakeReply() });
    expect(res).toEqual({ outcome: "proceed", idemKey: "rid-1" });
    const entry = await getCached(redis, "rid-1");
    expect(entry).toMatchObject({ marker: "in_progress" });
  });

  it("duplicate in-flight → 409 request_in_progress with retry-after", async () => {
    await setInFlight(redis, "rid-2", 300);
    const reply = fakeReply();
    const onResult: string[] = [];
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, requestKey: "rid-2", reply, onResult: (r) => onResult.push(r) });
    expect(res.outcome).toBe("conflict");
    expect(reply.calls.status).toBe(409);
    expect(reply.calls.headers["retry-after"]).toBe("1");
    expect(reply.calls.body).toMatchObject({ error: "request_in_progress" });
    expect(onResult).toEqual(["conflict"]);
  });

  it("completed entry → replays status/headers/body verbatim", async () => {
    await setCached(redis, "rid-3", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}').toString("base64"),
    }, 300);
    const reply = fakeReply();
    const onResult: string[] = [];
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, requestKey: "rid-3", reply, onResult: (r) => onResult.push(r) });
    expect(res.outcome).toBe("replayed");
    expect(reply.calls.status).toBe(200);
    expect(reply.calls.headers["content-type"]).toBe("application/json");
    expect(reply.calls.headers["x-idempotent-replay"]).toBe("true");
    expect((reply.calls.body as Buffer).toString()).toBe('{"ok":true}');
    expect(onResult).toEqual(["replayed"]);
  });

  it("strict mode + Redis error → 503 service_degraded (fail-closed)", async () => {
    const failing = { get: () => Promise.reject(new Error("down")) } as unknown as Redis;
    const reply = fakeReply();
    const res = await checkIdempotency({ redis: failing, ttlSec: 300, failClosed: true, requestKey: "rid-4", reply });
    expect(res.outcome).toBe("degraded");
    expect(reply.calls.status).toBe(503);
    expect(reply.calls.body).toMatchObject({ error: "service_degraded" });
  });

  it("lenient mode + Redis error → disabled (request proceeds without idempotency)", async () => {
    const failing = { get: () => Promise.reject(new Error("down")) } as unknown as Redis;
    const reply = fakeReply();
    const res = await checkIdempotency({ redis: failing, ttlSec: 300, failClosed: false, requestKey: "rid-5", reply });
    expect(res.outcome).toBe("disabled");
    expect(reply.calls.status).toBe(0); // nothing sent
  });
});

describe("storeIdempotent", () => {
  let redis: Redis;
  beforeEach(async () => {
    redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    await redis.flushall();
  });

  it("caches a 200 response under the idem key (base64 body round-trips)", async () => {
    storeIdempotent({ redis, ttlSec: 300 }, "rid-a", {
      status: 200,
      headers: { "content-type": "application/json", "x-skip": "no" },
      body: Buffer.from('{"hi":1}'),
    });
    // setCached is async fire-and-forget — allow the microtask to flush.
    await new Promise((r) => setTimeout(r, 5));
    const entry = await getCached(redis, "rid-a");
    expect(entry).toMatchObject({ status: 200 });
    const cr = entry as { headers: Record<string, string>; body: string };
    expect(cr.headers["content-type"]).toBe("application/json");
    expect(cr.headers["x-skip"]).toBeUndefined(); // not in allowlist
    expect(Buffer.from(cr.body, "base64").toString()).toBe('{"hi":1}');
  });

  it("does not store non-200 responses or a null key", async () => {
    storeIdempotent({ redis, ttlSec: 300 }, "rid-b", { status: 500, headers: {}, body: Buffer.from("x") });
    storeIdempotent({ redis, ttlSec: 300 }, null, { status: 200, headers: {}, body: Buffer.from("x") });
    await new Promise((r) => setTimeout(r, 5));
    expect(await getCached(redis, "rid-b")).toBeNull();
  });
});
