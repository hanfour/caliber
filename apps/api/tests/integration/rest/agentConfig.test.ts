import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import { agentConfigRoutes } from "../../../src/rest/agentConfig.js";
import { setupTestDb, makeOrg, makeUser, defaultTestEnv } from "../../factories/index.js";
import { devices, deviceApiKeys, organizations } from "@caliber/db";
import { eq } from "drizzle-orm";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;
let rawKey: string;
let orgId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  const org = await makeOrg(testDb.db);
  orgId = org.id;
  const user = await makeUser(testDb.db, { orgId });
  const [dev] = await testDb.db.insert(devices).values({
    userId: user.id, orgId, hostname: "h", os: "darwin", agentVersion: "0.2.0", status: "active",
  }).returning({ id: devices.id });
  const { raw, prefix } = generateDeviceKey();
  rawKey = raw;
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: dev!.id, keyHash: hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw), keyPrefix: prefix,
  });
  app = Fastify({ logger: false });
  app.decorate("db", testDb.db);
  await app.register(agentConfigRoutes(defaultTestEnv));
  await app.ready();
});
afterAll(async () => { await app.close(); await testDb.stop(); });

describe("GET /v1/agent-config", () => {
  it("401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agent-config" });
    expect(res.statusCode).toBe(401);
  });
  it("returns the default interval when org column is null", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agent-config", headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ poll_interval_seconds: 60, ttl_seconds: 3600 });
  });
  it("returns the org-configured interval", async () => {
    await testDb.db.update(organizations).set({ agentPollIntervalSeconds: 300 }).where(eq(organizations.id, orgId));
    const res = await app.inject({ method: "GET", url: "/v1/agent-config", headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.json().poll_interval_seconds).toBe(300);
  });
});
