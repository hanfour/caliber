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
    const r1 = await checkIdempotency({ redis, ttlSec: 0, failClosed: true, scope: "k", requestKey: "rid", reply: fakeReply() });
    expect(r1.outcome).toBe("disabled");
    const r2 = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "k", requestKey: null, reply: fakeReply() });
    expect(r2.outcome).toBe("disabled");
  });

  it("miss → writes an in-flight marker and returns proceed + idemKey", async () => {
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "k", requestKey: "rid-1", reply: fakeReply() });
    expect(res).toEqual({ outcome: "proceed", idemKey: "k:rid-1" });
    const entry = await getCached(redis, "k:rid-1");
    expect(entry).toMatchObject({ marker: "in_progress" });
  });

  it("duplicate in-flight → 409 request_in_progress with retry-after", async () => {
    await setInFlight(redis, "k:rid-2", 300);
    const reply = fakeReply();
    const onResult: string[] = [];
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "k", requestKey: "rid-2", reply, onResult: (r) => onResult.push(r) });
    expect(res.outcome).toBe("conflict");
    expect(reply.calls.status).toBe(409);
    expect(reply.calls.headers["retry-after"]).toBe("1");
    expect(reply.calls.body).toMatchObject({ error: "request_in_progress" });
    expect(onResult).toEqual(["conflict"]);
  });

  it("completed entry → replays status/headers/body verbatim", async () => {
    await setCached(redis, "k:rid-3", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}').toString("base64"),
    }, 300);
    const reply = fakeReply();
    const onResult: string[] = [];
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "k", requestKey: "rid-3", reply, onResult: (r) => onResult.push(r) });
    expect(res.outcome).toBe("replayed");
    expect(reply.calls.status).toBe(200);
    expect(reply.calls.headers["content-type"]).toBe("application/json");
    expect(reply.calls.headers["x-idempotent-replay"]).toBe("true");
    expect((reply.calls.body as Buffer).toString()).toBe('{"ok":true}');
    expect(onResult).toEqual(["replayed"]);
  });

  it("strict mode + Redis error → 503 service_degraded (fail-closed) + onRedisError", async () => {
    const failing = { get: () => Promise.reject(new Error("down")) } as unknown as Redis;
    const reply = fakeReply();
    let redisErrors = 0;
    const res = await checkIdempotency({ redis: failing, ttlSec: 300, failClosed: true, scope: "k", requestKey: "rid-4", reply, onRedisError: () => (redisErrors += 1) });
    expect(res.outcome).toBe("degraded");
    expect(reply.calls.status).toBe(503);
    expect(reply.calls.body).toMatchObject({ error: "service_degraded" });
    expect(redisErrors).toBe(1);
  });

  it("lenient mode + Redis error → disabled (request proceeds without idempotency) + onRedisError", async () => {
    const failing = { get: () => Promise.reject(new Error("down")) } as unknown as Redis;
    const reply = fakeReply();
    let redisErrors = 0;
    const res = await checkIdempotency({ redis: failing, ttlSec: 300, failClosed: false, scope: "k", requestKey: "rid-5", reply, onRedisError: () => (redisErrors += 1) });
    expect(res.outcome).toBe("disabled");
    expect(reply.calls.status).toBe(0); // nothing sent
    expect(redisErrors).toBe(1); // still counted as a raw redis error
  });

  it("malformed stored entry → fires onMalformed, then proceeds as a miss", async () => {
    await redis.set("idem:sc:rid-malformed", "not json at all", "EX", 300);
    let malformed = 0;
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "sc", requestKey: "rid-malformed", reply: fakeReply(), onMalformed: () => (malformed += 1) });
    // getCached treats malformed as a miss → checkIdempotency claims the slot.
    expect(res.outcome).toBe("proceed");
    expect(malformed).toBe(1);
  });

  it("scopes the Redis key by `scope` — a hit under another scope is a miss", async () => {
    await setCached(redis, "keyA:rid-z", { status: 200, headers: {}, body: Buffer.from("A").toString("base64") }, 300);
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "keyB", requestKey: "rid-z", reply: fakeReply() });
    expect(res.outcome).toBe("proceed");
    expect(res.idemKey).toBe("keyB:rid-z");
  });

  // Fix A — TOCTOU race. The GET reads a miss, but a concurrent request claims
  // the slot before this one's atomic SET NX runs → the SET loses (key exists),
  // so we must emit the SAME 409 conflict rather than proceeding upstream
  // (which would double-dispatch). Simulated by a redis whose GET returns a miss
  // while the key already holds a marker, so SET NX returns null.
  it("miss-then-lost-race (claim NX fails) → 409 request_in_progress, NOT proceed", async () => {
    // Pre-seed a real marker so SET NX will fail, but force GET to report a miss
    // to reproduce the window where this caller read empty before claiming.
    await setInFlight(redis, "k:rid-race", 300);
    const racing = Object.assign(Object.create(Object.getPrototypeOf(redis)), redis, {
      get: () => Promise.resolve(null), // GET sees a miss…
      set: (...args: unknown[]) => (redis.set as (...a: unknown[]) => unknown)(...args), // …but real SET NX loses
    }) as unknown as Redis;
    const reply = fakeReply();
    const onResult: string[] = [];
    const res = await checkIdempotency({ redis: racing, ttlSec: 300, failClosed: true, scope: "k", requestKey: "rid-race", reply, onResult: (r) => onResult.push(r) });
    expect(res).toEqual({ outcome: "conflict", idemKey: null });
    expect(reply.calls.status).toBe(409);
    expect(reply.calls.headers["retry-after"]).toBe("1");
    expect(reply.calls.body).toMatchObject({ error: "request_in_progress", requestId: "rid-race" });
    expect(onResult).toEqual(["conflict"]);
  });

  it("409 body reports the RAW X-Request-Id, not the scoped composite", async () => {
    await setInFlight(redis, "keyA:rid-dup", 300);
    const reply = fakeReply();
    const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "keyA", requestKey: "rid-dup", reply });
    expect(res.outcome).toBe("conflict");
    expect(reply.calls.body).toMatchObject({ error: "request_in_progress", requestId: "rid-dup" });
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
