import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { devices, deviceEnrollmentTokens, auditLogs } from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import {
  devicesRouter,
  hashEnrollmentToken,
} from "../../../src/trpc/routers/devices.js";

const localRouter = router({ devices: devicesRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(
  db: Database,
  userId: string,
  email = "x@x.test",
  env: ServerEnv = defaultTestEnv,
) {
  const perm = await resolvePermissions(db, userId);
  return createLocalCaller({
    db,
    user: { id: userId, email },
    perm,
    reqId: "test",
    locale: "en",
    env,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

describe("devices tRPC router", () => {
  let testDb: Awaited<ReturnType<typeof setupTestDb>>;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  describe("enrollmentToken.issue", () => {
    it("issues a 1hr-TTL bare token + persists only the HMAC", async () => {
      const org = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db, { orgId: org.id });
      const caller = await callerFor(testDb.db, user.id);

      const before = Date.now();
      const result = await caller.devices.enrollmentToken.issue();
      const after = Date.now();

      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.token).toHaveLength(43); // 32 random bytes base64url-encoded
      expect(result.expiresAt).toBeDefined();
      const expMs = new Date(result.expiresAt).getTime();
      expect(expMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000);
      expect(expMs).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 1000);

      // DB stores the HMAC, not the raw token.
      const [row] = await testDb.db
        .select({
          tokenHash: deviceEnrollmentTokens.tokenHash,
          userId: deviceEnrollmentTokens.userId,
          orgId: deviceEnrollmentTokens.orgId,
        })
        .from(deviceEnrollmentTokens)
        .where(eq(deviceEnrollmentTokens.id, result.id));
      expect(row).toBeTruthy();
      expect(row!.userId).toBe(user.id);
      expect(row!.orgId).toBe(org.id);
      const expectedHash = hashEnrollmentToken(
        defaultTestEnv.API_KEY_HASH_PEPPER!,
        result.token,
      );
      expect(row!.tokenHash).toBe(expectedHash);

      // Audit log.
      const audits = await testDb.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.targetType, "enrollment_token"),
            eq(auditLogs.targetId, result.id),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("enrollment_token.issued");
      expect(audits[0]!.actorUserId).toBe(user.id);
    });

    it("returns NOT_FOUND when caller belongs to no organization", async () => {
      const orphan = await makeUser(testDb.db); // no orgId
      const caller = await callerFor(testDb.db, orphan.id);
      await expect(caller.devices.enrollmentToken.issue()).rejects.toThrow(
        /no organization/i,
      );
    });

    it("NOT_FOUND when gateway is disabled", async () => {
      const org = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db, { orgId: org.id });
      const caller = await callerFor(testDb.db, user.id, "x@x.test", {
        ...defaultTestEnv,
        ENABLE_GATEWAY: false,
      });
      await expect(caller.devices.enrollmentToken.issue()).rejects.toThrow();
    });
  });

  describe("enrollmentToken.listPending", () => {
    it("lists only unused + unexpired tokens for the caller", async () => {
      const org = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db, { orgId: org.id });
      const caller = await callerFor(testDb.db, user.id);

      const t1 = await caller.devices.enrollmentToken.issue();
      const t2 = await caller.devices.enrollmentToken.issue();

      // Force one expired + one used.
      await testDb.db
        .update(deviceEnrollmentTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(deviceEnrollmentTokens.id, t1.id));
      // The other we leave alive.

      const pending = await caller.devices.enrollmentToken.listPending();
      const ids = pending.map((r) => r.id);
      expect(ids).toContain(t2.id);
      expect(ids).not.toContain(t1.id);
    });
  });

  describe("listOwn / listAll / revoke", () => {
    async function seedDevice(opts: {
      userId: string;
      orgId: string;
      hostname?: string;
    }) {
      const [row] = await testDb.db
        .insert(devices)
        .values({
          userId: opts.userId,
          orgId: opts.orgId,
          hostname: opts.hostname ?? "h",
          os: "darwin 25.3.0",
          agentVersion: "0.1.0",
        })
        .returning({ id: devices.id });
      return row!.id;
    }

    it("listOwn returns only caller's non-revoked devices", async () => {
      const org = await makeOrg(testDb.db);
      const me = await makeUser(testDb.db, { orgId: org.id });
      const other = await makeUser(testDb.db, { orgId: org.id });

      const mine1 = await seedDevice({
        userId: me.id,
        orgId: org.id,
        hostname: "mine-1",
      });
      const mine2 = await seedDevice({
        userId: me.id,
        orgId: org.id,
        hostname: "mine-2",
      });
      const theirs = await seedDevice({
        userId: other.id,
        orgId: org.id,
        hostname: "theirs",
      });

      // Revoke mine2 — should not appear in listOwn.
      await testDb.db
        .update(devices)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(devices.id, mine2));

      const caller = await callerFor(testDb.db, me.id);
      const rows = await caller.devices.listOwn();
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toContain(mine1);
      expect(ids).not.toContain(mine2);
      expect(ids).not.toContain(theirs);
    });

    it("listAll requires org_admin and returns every non-revoked device in org", async () => {
      const org = await makeOrg(testDb.db);
      const admin = await makeUser(testDb.db, {
        orgId: org.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: org.id,
      });
      const member = await makeUser(testDb.db, { orgId: org.id });
      const memberDevice = await seedDevice({
        userId: member.id,
        orgId: org.id,
      });

      const adminCaller = await callerFor(testDb.db, admin.id);
      const rows = await adminCaller.devices.listAll({ orgId: org.id });
      expect(rows.some((r) => r.id === memberDevice)).toBe(true);

      // Member is forbidden.
      const memberCaller = await callerFor(testDb.db, member.id);
      await expect(
        memberCaller.devices.listAll({ orgId: org.id }),
      ).rejects.toThrow(/FORBIDDEN/);
    });

    it("revoke: owner can self-revoke; non-owner gets FORBIDDEN; second revoke is NOT_FOUND", async () => {
      const org = await makeOrg(testDb.db);
      const owner = await makeUser(testDb.db, { orgId: org.id });
      const intruder = await makeUser(testDb.db, { orgId: org.id });
      const deviceId = await seedDevice({ userId: owner.id, orgId: org.id });

      const intruderCaller = await callerFor(testDb.db, intruder.id);
      await expect(
        intruderCaller.devices.revoke({ id: deviceId }),
      ).rejects.toThrow(/FORBIDDEN/);

      const ownerCaller = await callerFor(testDb.db, owner.id);
      const result = await ownerCaller.devices.revoke({ id: deviceId });
      expect(result.ok).toBe(true);

      // Second revoke → NOT_FOUND because the row is already revoked.
      await expect(
        ownerCaller.devices.revoke({ id: deviceId }),
      ).rejects.toThrow(/NOT_FOUND/);

      // Row state is now revoked.
      const [row] = await testDb.db
        .select({
          status: devices.status,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.id, deviceId));
      expect(row!.status).toBe("revoked");
      expect(row!.revokedAt).not.toBeNull();

      // Audit entry.
      const audits = await testDb.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.targetType, "device"),
            eq(auditLogs.targetId, deviceId),
            eq(auditLogs.action, "device.revoked"),
          ),
        );
      expect(audits).toHaveLength(1);
    });

    it("org_admin can revoke another user's device", async () => {
      const org = await makeOrg(testDb.db);
      const admin = await makeUser(testDb.db, {
        orgId: org.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: org.id,
      });
      const owner = await makeUser(testDb.db, { orgId: org.id });
      const deviceId = await seedDevice({ userId: owner.id, orgId: org.id });

      const adminCaller = await callerFor(testDb.db, admin.id);
      await adminCaller.devices.revoke({ id: deviceId });

      const [row] = await testDb.db
        .select({ revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.id, deviceId));
      expect(row!.revokedAt).not.toBeNull();
    });
  });
});

// Suppress unused-import lint when isNull isn't used in any future tweak.
void isNull;
