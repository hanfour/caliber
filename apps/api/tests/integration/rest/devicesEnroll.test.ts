import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  devices,
  deviceEnrollmentTokens,
  deviceApiKeys,
  auditLogs,
} from "@caliber/db";
import { verifyDeviceKey } from "@caliber/gateway-core";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
} from "../../factories/index.js";
import { devicesEnrollRoutes } from "../../../src/rest/devicesEnroll.js";
import { hashEnrollmentToken } from "../../../src/trpc/routers/devices.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;

async function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate("db", testDb.db);
  await fastify.register(devicesEnrollRoutes(defaultTestEnv));
  return fastify;
}

async function seedEnrollmentToken(opts: {
  userId: string;
  orgId: string;
  expiresAt?: Date;
  usedAt?: Date;
}) {
  const token = `t-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const tokenHash = hashEnrollmentToken(
    defaultTestEnv.API_KEY_HASH_PEPPER!,
    token,
  );
  const [row] = await testDb.db
    .insert(deviceEnrollmentTokens)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      tokenHash,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      usedAt: opts.usedAt ?? null,
    })
    .returning({ id: deviceEnrollmentTokens.id });
  return { id: row!.id, token };
}

describe("POST /v1/devices/enroll", () => {
  beforeAll(async () => {
    testDb = await setupTestDb();
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it("redeems a valid token: creates device + cda_* key, marks token used, audits", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const { id: tokenId, token } = await seedEnrollmentToken({
      userId: user.id,
      orgId: org.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: {
        token,
        hostname: "mbp-test",
        os: "darwin 25.3.0 arm64",
        agentVersion: "0.1.0",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.key).toMatch(/^cda_/);
    expect(body.keyPrefix).toMatch(/^cda_/);
    expect(body.keyPrefix.length).toBe(9);
    expect(body.key.length).toBeGreaterThanOrEqual(60);

    // Device row was created with the right owner.
    const [device] = await testDb.db
      .select()
      .from(devices)
      .where(eq(devices.id, body.deviceId));
    expect(device!.userId).toBe(user.id);
    expect(device!.orgId).toBe(org.id);
    expect(device!.hostname).toBe("mbp-test");
    expect(device!.agentVersion).toBe("0.1.0");
    expect(device!.status).toBe("active");

    // device_api_keys row stores the HMAC, not the raw key.
    const [keyRow] = await testDb.db
      .select()
      .from(deviceApiKeys)
      .where(eq(deviceApiKeys.deviceId, body.deviceId));
    expect(keyRow!.keyPrefix).toBe(body.keyPrefix);
    expect(keyRow!.keyHash).not.toBe(body.key);
    expect(
      verifyDeviceKey(
        defaultTestEnv.API_KEY_HASH_PEPPER!,
        body.key,
        keyRow!.keyHash,
      ),
    ).toBe(true);

    // Enrollment token was marked used + linked to the new device.
    const [usedToken] = await testDb.db
      .select({
        usedAt: deviceEnrollmentTokens.usedAt,
        usedByDeviceId: deviceEnrollmentTokens.usedByDeviceId,
      })
      .from(deviceEnrollmentTokens)
      .where(eq(deviceEnrollmentTokens.id, tokenId));
    expect(usedToken!.usedAt).not.toBeNull();
    expect(usedToken!.usedByDeviceId).toBe(body.deviceId);

    // Audit log entry: action=device.enrolled, actor=token owner.
    const audits = await testDb.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, body.deviceId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("device.enrolled");
    expect(audits[0]!.actorUserId).toBe(user.id);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: {
        token: "definitely-not-a-real-token-xxxxxxxxxxxxxxxxxxxx",
        hostname: "h",
        os: "darwin",
        agentVersion: "0.1.0",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_token" });
  });

  it("returns 410 for an already-used token (idempotency)", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const { token } = await seedEnrollmentToken({
      userId: user.id,
      orgId: org.id,
    });

    const first = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: { token, hostname: "a", os: "darwin", agentVersion: "0.1.0" },
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: { token, hostname: "b", os: "darwin", agentVersion: "0.1.0" },
    });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toEqual({ error: "token_already_used" });
  });

  it("returns 410 for an expired token", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const { token } = await seedEnrollmentToken({
      userId: user.id,
      orgId: org.id,
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: { token, hostname: "h", os: "darwin", agentVersion: "0.1.0" },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: "token_expired" });
  });

  it("returns 400 for malformed body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: { token: "x", hostname: "" }, // missing os, agentVersion + bad token
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("returns 404 when gateway is disabled", async () => {
    const disabledApp = Fastify({ logger: false });
    disabledApp.decorate("db", testDb.db);
    await disabledApp.register(
      devicesEnrollRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }),
    );

    const res = await disabledApp.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: {
        token: "anything-here-just-to-pass-length-checks-x",
        hostname: "h",
        os: "darwin",
        agentVersion: "0.1.0",
      },
    });
    expect(res.statusCode).toBe(404);
    await disabledApp.close();
  });

  it("FK enforcement: enrolled device's user_id + org_id match the token's", async () => {
    // Sanity that the row chain ends up tenant-consistent even though the
    // POST body doesn't carry user/org info — server reads them from the token.
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const { token } = await seedEnrollmentToken({
      userId: user.id,
      orgId: org.id,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/enroll",
      payload: { token, hostname: "h", os: "darwin", agentVersion: "0.1.0" },
    });
    expect(res.statusCode).toBe(201);
    const { deviceId } = res.json();
    const [row] = await testDb.db
      .select({ userId: devices.userId, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId));
    expect(row!.userId).toBe(user.id);
    expect(row!.orgId).toBe(org.id);
  });
});

void sql;
