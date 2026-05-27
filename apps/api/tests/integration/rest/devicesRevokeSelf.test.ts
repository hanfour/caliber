// apps/api/tests/integration/rest/devicesRevokeSelf.test.ts
// Integration tests for DELETE /v1/devices/me. 10 cases per the PR4 plan:
//   1. happy → 204 + DB revokedAt set + audit log
//   2. 2nd call → 410 device_already_revoked (idempotent)
//   3. invalid token → 401 invalid_token
//   4. revoked key → 401 key_revoked
//   5. **pre-revoked device → 410 (NOT 401)** — verifies allow-revoked logic
//   6. frozen device → 401 device_inactive
//   7. ak_* token → 401 invalid_token
//   8. 10× concurrent → 1× 204 + 9× 410
//   9. ENABLE_GATEWAY=false → 404 not_found
//  10. API_KEY_HASH_PEPPER missing → 500 internal
//
// Seed helpers are inlined (matching ingest.test.ts / devicesEnroll.test.ts).
// We do NOT extract a tests/integration/helpers/devicesFixtures.ts module:
// the existing test files use this inline pattern and the plan-suggested
// helper module does not exist yet, so introducing one here would be a wider
// refactor than this PR scope.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { devices, deviceApiKeys, auditLogs } from "@caliber/db";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
} from "../../factories/index.js";
import { devicesRevokeSelfRoutes } from "../../../src/rest/devicesRevokeSelf.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;

interface SeedResult {
  deviceId: string;
  userId: string;
  orgId: string;
  token: string;
}

async function buildApp(envOverride?: Partial<typeof defaultTestEnv>) {
  const fastify = Fastify({ logger: false });
  fastify.decorate("db", testDb.db);
  await fastify.register(
    devicesRevokeSelfRoutes({ ...defaultTestEnv, ...envOverride }),
  );
  return fastify;
}

async function seedActiveDevice(): Promise<SeedResult> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "test-host",
      os: "darwin",
      agentVersion: "0.1.0",
      status: "active",
    })
    .returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
  });
  return {
    deviceId: device!.id,
    userId: user.id,
    orgId: org.id,
    token: raw,
  };
}

async function seedRevokedDevice(): Promise<SeedResult> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "test-host",
      os: "darwin",
      agentVersion: "0.1.0",
      status: "revoked",
      revokedAt: new Date(),
    })
    .returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
  });
  return {
    deviceId: device!.id,
    userId: user.id,
    orgId: org.id,
    token: raw,
  };
}

async function seedRevokedKey(): Promise<SeedResult> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "test-host",
      os: "darwin",
      agentVersion: "0.1.0",
      status: "active",
    })
    .returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
    revokedAt: new Date(),
  });
  return {
    deviceId: device!.id,
    userId: user.id,
    orgId: org.id,
    token: raw,
  };
}

async function seedFrozenDevice(): Promise<SeedResult> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: user.id,
      orgId: org.id,
      hostname: "test-host",
      os: "darwin",
      agentVersion: "0.1.0",
      status: "frozen",
    })
    .returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
  });
  return {
    deviceId: device!.id,
    userId: user.id,
    orgId: org.id,
    token: raw,
  };
}

beforeAll(async () => {
  testDb = await setupTestDb();
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("DELETE /v1/devices/me", () => {
  it("happy path → 204 + devices.revokedAt set + audit log device.self_revoked written", async () => {
    const fx = await seedActiveDevice();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await testDb.db
      .select()
      .from(devices)
      .where(eq(devices.id, fx.deviceId));
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.status).toBe("revoked");

    const audits = await testDb.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, fx.deviceId));
    const selfRevoke = audits.find((a) => a.action === "device.self_revoked");
    expect(selfRevoke).toBeDefined();
    expect(selfRevoke!.actorUserId).toBe(fx.userId);
    expect(selfRevoke!.orgId).toBe(fx.orgId);
    expect(selfRevoke!.targetType).toBe("device");
    // metadata contains the trigger marker
    expect((selfRevoke!.metadata as { trigger?: string }).trigger).toBe(
      "agent_uninstall",
    );
  });

  it("repeated call → 410 device_already_revoked (idempotent; allow-revoked variant does NOT return 401)", async () => {
    const fx = await seedActiveDevice();
    const first = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(second.statusCode).toBe(410);
    expect(second.json().error).toBe("device_already_revoked");
  });

  it("invalid token → 401 invalid_token", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: "Bearer cda_invalidxxxxxxxxxxxxxxxxxxxxxx" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("revoked api key → 401 key_revoked", async () => {
    const fx = await seedRevokedKey();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("key_revoked");
  });

  it("pre-revoked device (devices.revokedAt set) → 410 device_already_revoked (NOT 401)", async () => {
    const fx = await seedRevokedDevice();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("device_already_revoked");
  });

  it("frozen device (status='frozen', not revoked) → 401 device_inactive", async () => {
    const fx = await seedFrozenDevice();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("device_inactive");
  });

  it("ak_* token (not cda_*) → 401 invalid_token", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: "Bearer ak_someothertypeofkey1234567890" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("10× concurrent revoke → 1× 204 + 9× 410 (race serialisation via revoked_at IS NULL guard)", async () => {
    const fx = await seedActiveDevice();
    const tries = Array.from({ length: 10 }, () =>
      app.inject({
        method: "DELETE",
        url: "/v1/devices/me",
        headers: { authorization: `Bearer ${fx.token}` },
      }),
    );
    const results = await Promise.all(tries);
    const counts = results.reduce(
      (acc, r) => {
        acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
        return acc;
      },
      {} as Record<number, number>,
    );
    expect(counts[204]).toBe(1);
    expect(counts[410]).toBe(9);

    // Exactly one device.self_revoked audit was written even though 10
    // requests reached the route — the WHERE revoked_at IS NULL guard makes
    // 9 of them rowCount=0 and they skip the writeAudit call.
    const audits = await testDb.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, fx.deviceId));
    const selfRevokes = audits.filter((a) => a.action === "device.self_revoked");
    expect(selfRevokes).toHaveLength(1);
  });

  it("ENABLE_GATEWAY=false → 404 not_found", async () => {
    const disabledApp = await buildApp({ ENABLE_GATEWAY: false });
    try {
      const fx = await seedActiveDevice();
      const res = await disabledApp.inject({
        method: "DELETE",
        url: "/v1/devices/me",
        headers: { authorization: `Bearer ${fx.token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    } finally {
      await disabledApp.close();
    }
  });

  it("API_KEY_HASH_PEPPER missing → 500 internal (server_misconfigured, not 401)", async () => {
    const noPepperApp = await buildApp({ API_KEY_HASH_PEPPER: "" });
    try {
      const fx = await seedActiveDevice();
      const res = await noPepperApp.inject({
        method: "DELETE",
        url: "/v1/devices/me",
        headers: { authorization: `Bearer ${fx.token}` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("internal");
    } finally {
      await noPepperApp.close();
    }
  });
});
