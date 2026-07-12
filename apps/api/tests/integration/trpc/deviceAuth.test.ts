import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLogs, deviceEnrollmentTokens } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  makeTestRedis,
  defaultTestEnv,
} from "../../factories/index.js";
import { hashDeviceCode, flowKey, userCodeKey } from "../../../src/rest/deviceAuth.js";
import { AUDIT_ACTIONS } from "../../../src/services/auditActions.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
const redis = makeTestRedis();
let userId: string;
let orgId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  userId = user.id;
  orgId = org.id;
});
afterAll(async () => {
  await testDb.stop();
});
beforeEach(async () => {
  await redis.flushall();
});

async function seedPending(
  userCode = "BCDF-GHJK",
  opts: { provisionGateway?: boolean; hostname?: string } = {},
) {
  const deviceCode = "dc_" + userCode;
  const codeHash = hashDeviceCode(deviceCode);
  const flow = {
    status: "pending",
    userCode,
    hostname: opts.hostname ?? "mbp",
    os: "darwin",
    agentVersion: "0.2.0",
    provisionGateway: opts.provisionGateway,
    createdAt: new Date().toISOString(),
  };
  await redis.set(flowKey(codeHash), JSON.stringify(flow), "EX", 900);
  await redis.set(userCodeKey(userCode), codeHash, "EX", 900);
  return { deviceCode, codeHash };
}

function caller() {
  return callerFor(testDb.db, userId, "u@x.co", defaultTestEnv, redis);
}

describe("devices.deviceAuth", () => {
  it("lookup returns device metadata for a pending flow", async () => {
    await seedPending();
    const c = await caller();
    const res = await c.devices.deviceAuth.lookup({ userCode: "bcdf ghjk" }); // normalized
    expect(res).toMatchObject({ hostname: "mbp", os: "darwin" });
  });

  it("lookup throws NOT_FOUND for unknown code", async () => {
    const c = await caller();
    await expect(
      c.devices.deviceAuth.lookup({ userCode: "ZZZZ-ZZZZ" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("approve writes an enrollment token into the flow and inserts a DB row", async () => {
    const { codeHash } = await seedPending();
    const c = await caller();
    const res = await c.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" });
    expect(res.ok).toBe(true);
    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("approved");
    expect(typeof flow.enrollmentToken).toBe("string");
    expect(flow.enrollmentToken.length).toBeGreaterThan(20);
    expect(flow.cliAccessToken).toMatch(/^cct_/);
    expect(flow.gatewayProvisioning).toMatchObject({
      requested: false,
      status: "not_requested",
    });
  });

  it("approve is idempotent-safe: second approve throws PRECONDITION_FAILED", async () => {
    await seedPending();
    const c = await caller();
    await c.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" });
    await expect(
      c.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("approve atomically claims the flow before minting tokens or gateway keys", async () => {
    const userCode = "JKMN-PQRS";
    const keyName = "mbp-concurrent (caliber login)";
    const { codeHash } = await seedPending(userCode, {
      provisionGateway: true,
      hostname: "mbp-concurrent",
    });
    const c = await caller();
    const beforeTokens = await testDb.db
      .select({ id: deviceEnrollmentTokens.id })
      .from(deviceEnrollmentTokens)
      .where(eq(deviceEnrollmentTokens.userId, userId));

    const results = await Promise.allSettled([
      c.devices.deviceAuth.approve({ userCode }),
      c.devices.deviceAuth.approve({ userCode }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("approved");
    expect(typeof flow.enrollmentToken).toBe("string");
    expect(typeof flow.apiKey).toBe("string");
    expect(flow.gatewayProvisioning).toMatchObject({
      requested: true,
      status: "provisioned",
      gatewayUrl: defaultTestEnv.GATEWAY_BASE_URL,
    });

    const afterTokens = await testDb.db
      .select({ id: deviceEnrollmentTokens.id })
      .from(deviceEnrollmentTokens)
      .where(eq(deviceEnrollmentTokens.userId, userId));
    expect(afterTokens.length - beforeTokens.length).toBe(1);

    const keys = await testDb.db
      .select({
        id: apiKeys.id,
        status: apiKeys.status,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), eq(apiKeys.name, keyName)));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.status).toBe("active");
    expect(keys[0]!.revokedAt).toBeNull();
  });

  it("approve records already_exists when the gateway key name is active", async () => {
    const userCode = "PQRS-TVWX";
    const hostname = "gw-existing";
    const keyName = `${hostname} (caliber login)`;
    await testDb.db.insert(apiKeys).values({
      userId,
      orgId,
      teamId: null,
      groupId: null,
      keyHash: `existing-gw-${Date.now()}`,
      keyPrefix: "ak_existing",
      name: keyName,
      status: "active",
      issuedByUserId: null,
      routingPolicy: "own_then_pool",
    });
    const { codeHash } = await seedPending(userCode, {
      provisionGateway: true,
      hostname,
    });
    const c = await caller();

    await c.devices.deviceAuth.approve({ userCode });

    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("approved");
    expect(flow.apiKey).toBeUndefined();
    expect(flow.gatewayProvisioning).toMatchObject({
      requested: true,
      status: "already_exists",
      gatewayUrl: defaultTestEnv.GATEWAY_BASE_URL,
    });

    const auditRows = await testDb.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, userId),
          eq(auditLogs.action, AUDIT_ACTIONS.DEVICE_AUTH_APPROVED),
        ),
      );
    const audit = auditRows.find(
      (row) =>
        (row.metadata as { hostname?: string }).hostname === hostname,
    );
    expect(audit?.metadata).toMatchObject({
      hostname,
      provisionGatewayRequested: true,
      gatewayProvisioningStatus: "already_exists",
    });
  });

  it("deny marks the flow denied and audits with the caller's real orgId (not null)", async () => {
    const { codeHash } = await seedPending();
    const c = await caller();
    await c.devices.deviceAuth.deny({ userCode: "BCDF-GHJK" });
    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("denied");

    const [auditRow] = await testDb.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, userId),
          eq(auditLogs.action, AUDIT_ACTIONS.DEVICE_AUTH_DENIED),
        ),
      )
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow!.orgId).toBe(orgId);
  });
});

describe("devices.agentConfig", () => {
  it("get returns default 60 when unset; set clamps out-of-range", async () => {
    const org = await makeOrg(testDb.db);
    const admin = await makeUser(testDb.db, {
      orgId: org.id,
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const orgId = org.id;
    const c = await callerFor(testDb.db, admin.id, "admin@x.co", defaultTestEnv, redis);

    expect((await c.devices.agentConfig.get({ orgId })).pollIntervalSeconds).toBe(60);
    const set = await c.devices.agentConfig.set({ orgId, pollIntervalSeconds: 5 });
    expect(set.pollIntervalSeconds).toBe(30); // clamped to min
    expect((await c.devices.agentConfig.get({ orgId })).pollIntervalSeconds).toBe(30);
  });

  it("non-admin is FORBIDDEN", async () => {
    const org = await makeOrg(testDb.db);
    const member = await makeUser(testDb.db, { orgId: org.id });
    const c = await callerFor(testDb.db, member.id, "member@x.co", defaultTestEnv, redis);
    await expect(
      c.devices.agentConfig.get({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
