// apps/api/tests/integration/rest/ingestAuth.test.ts
// Unit-style integration tests for the resolveDeviceFromAuthAllowRevoked
// sister helper introduced in PR4. The original resolveDeviceFromAuth is
// indirectly covered by ingest.test.ts and devicesEnroll.test.ts; this file
// focuses on the alreadyRevoked short-circuit semantics that DELETE
// /v1/devices/me depends on (see ingestAuth.ts for the why).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { devices, deviceApiKeys } from "@caliber/db";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
} from "../../factories/index.js";
import { resolveDeviceFromAuthAllowRevoked } from "../../../src/rest/ingestAuth.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;

interface SeedResult {
  deviceId: string;
  userId: string;
  orgId: string;
  token: string;
}

async function seedDevice(opts?: {
  status?: string;
  revokedAt?: Date | null;
  keyRevokedAt?: Date | null;
}): Promise<SeedResult> {
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
      status: opts?.status ?? "active",
      revokedAt: opts?.revokedAt ?? null,
    })
    .returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: device!.id,
    keyHash,
    keyPrefix: prefix,
    revokedAt: opts?.keyRevokedAt ?? null,
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
});

afterAll(async () => {
  await testDb.stop();
});

describe("resolveDeviceFromAuthAllowRevoked", () => {
  it("returns alreadyRevoked=false for active device", async () => {
    const fx = await seedDevice();
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.device.alreadyRevoked).toBe(false);
      expect(r.device.deviceId).toBe(fx.deviceId);
      expect(r.device.userId).toBe(fx.userId);
      expect(r.device.orgId).toBe(fx.orgId);
    }
  });

  it("returns alreadyRevoked=true for revoked device (does NOT return device_revoked)", async () => {
    const fx = await seedDevice({
      status: "revoked",
      revokedAt: new Date(),
    });
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.device.alreadyRevoked).toBe(true);
      expect(r.device.deviceId).toBe(fx.deviceId);
    }
  });

  it("short-circuits revoked device BEFORE status check (status='revoked' + revokedAt set)", async () => {
    // This exact combination is what the route writes; the helper MUST still
    // return ok+alreadyRevoked=true here, not device_inactive.
    const fx = await seedDevice({
      status: "revoked",
      revokedAt: new Date(),
    });
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.alreadyRevoked).toBe(true);
  });

  it("returns 401 key_revoked when device_api_keys.revoked_at is set", async () => {
    const fx = await seedDevice({ keyRevokedAt: new Date() });
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("key_revoked");
  });

  it("returns 401 device_inactive for status='frozen' but not revoked", async () => {
    const fx = await seedDevice({ status: "frozen" });
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("device_inactive");
  });

  it("returns 401 invalid_token for unknown cda_* key", async () => {
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      "Bearer cda_doesnotexistabcdef1234567890",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_token");
  });

  it("returns 401 invalid_token for non-cda_* bearer (ak_*)", async () => {
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      "Bearer ak_notadeviceformatkey12345",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_token");
  });

  it("returns 401 missing_token when header absent", async () => {
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      defaultTestEnv,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_token");
  });

  it("returns 500 server_misconfigured when API_KEY_HASH_PEPPER is empty", async () => {
    const r = await resolveDeviceFromAuthAllowRevoked(
      testDb.db,
      { ...defaultTestEnv, API_KEY_HASH_PEPPER: "" },
      "Bearer cda_anything1234567890",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("server_misconfigured");
  });

  // Sanity: ensure the existing resolveDeviceFromAuth was NOT modified by
  // confirming its device_revoked path still trips for the same fixture.
  it("contrast: original resolveDeviceFromAuth still returns device_revoked for revoked device", async () => {
    const { resolveDeviceFromAuth } = await import(
      "../../../src/rest/ingestAuth.js"
    );
    const fx = await seedDevice({
      status: "revoked",
      revokedAt: new Date(),
    });
    const r = await resolveDeviceFromAuth(
      testDb.db,
      defaultTestEnv,
      `Bearer ${fx.token}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("device_revoked");

    // Cleanup: silence "row" being unused — the eq import is needed below.
    void devices;
    void eq;
  });
});
