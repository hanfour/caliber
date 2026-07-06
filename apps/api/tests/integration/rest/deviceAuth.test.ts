import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deviceAuthRoutes, hashDeviceCode, flowKey, userCodeKey,
} from "../../../src/rest/deviceAuth.js";
import { defaultTestEnv, makeTestRedis } from "../../factories/index.js";

const redis = makeTestRedis();
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(deviceAuthRoutes(defaultTestEnv, redis));
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await redis.flushall(); });

const startPayload = { hostname: "mbp-test", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" };

describe("POST /v1/device-auth/start", () => {
  it("201 returns RFC8628-shaped fields and stores a pending flow", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32B base64url
    expect(body.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/);
    expect(body.verification_uri).toBe(`${defaultTestEnv.NEXTAUTH_URL.replace(/\/$/, "")}/device`);
    expect(body.verification_uri_complete).toBe(`${body.verification_uri}?code=${body.user_code}`);
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(900);
    const raw = await redis.get(flowKey(hashDeviceCode(body.device_code)));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ status: "pending", userCode: body.user_code, hostname: "mbp-test" });
    expect(await redis.get(userCodeKey(body.user_code))).toBe(hashDeviceCode(body.device_code));
    expect(await redis.ttl(flowKey(hashDeviceCode(body.device_code)))).toBeGreaterThan(890);
  });
  it("400 on invalid body", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: { os: "darwin" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
  it("404 when gateway disabled", async () => {
    const off = Fastify({ logger: false });
    await off.register(deviceAuthRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }, redis));
    const res = await off.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    expect(res.statusCode).toBe(404);
    await off.close();
  });
});

describe("POST /v1/device-auth/poll", () => {
  async function startFlow() {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    return res.json() as { device_code: string; user_code: string };
  }
  it("authorization_pending while pending", async () => {
    const { device_code } = await startFlow();
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("authorization_pending");
  });
  it("expired_token for unknown device_code", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code: "nope-nope-nope-nope" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("expired_token");
  });
  it("access_denied once denied, and the flow is deleted", async () => {
    const { device_code, user_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    const flow = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...flow, status: "denied" }), "EX", 900);
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.json().error).toBe("access_denied");
    expect(await redis.get(key)).toBeNull();
    expect(await redis.get(userCodeKey(user_code))).toBeNull();
  });
  it("returns enrollment_token exactly once when approved", async () => {
    const { device_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    const flow = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...flow, status: "approved", enrollmentToken: "tok_abc" }), "EX", 900);
    const ok = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().enrollment_token).toBe("tok_abc");
    const again = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(again.json().error).toBe("expired_token"); // single collection
  });
  it("expired_token on corrupt payload (and deletes it)", async () => {
    const { device_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    await redis.set(key, "{not json", "EX", 900);
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.json().error).toBe("expired_token");
    expect(await redis.get(key)).toBeNull();
  });
});
