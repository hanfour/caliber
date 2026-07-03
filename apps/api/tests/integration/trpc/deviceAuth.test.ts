import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  makeTestRedis,
  defaultTestEnv,
} from "../../factories/index.js";
import { hashDeviceCode, flowKey, userCodeKey } from "../../../src/rest/deviceAuth.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
const redis = makeTestRedis();
let userId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  userId = user.id;
});
afterAll(async () => {
  await testDb.stop();
});
beforeEach(async () => {
  await redis.flushall();
});

async function seedPending(userCode = "BCDF-GHJK") {
  const deviceCode = "dc_" + userCode;
  const codeHash = hashDeviceCode(deviceCode);
  const flow = {
    status: "pending",
    userCode,
    hostname: "mbp",
    os: "darwin",
    agentVersion: "0.2.0",
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
  });

  it("approve is idempotent-safe: second approve throws PRECONDITION_FAILED", async () => {
    await seedPending();
    const c = await caller();
    await c.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" });
    await expect(
      c.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("deny marks the flow denied", async () => {
    const { codeHash } = await seedPending();
    const c = await caller();
    await c.devices.deviceAuth.deny({ userCode: "BCDF-GHJK" });
    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("denied");
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
