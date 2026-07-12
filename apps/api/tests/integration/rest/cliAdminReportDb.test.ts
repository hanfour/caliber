import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLogs,
  clientEvents,
  clientSessions,
  devices,
  type Database,
} from "@caliber/db";
import { and, eq } from "drizzle-orm";
import { cliAdminReportRoutes } from "../../../src/rest/cliAdminReport.js";
import { cliAccessKey, hashCliAccessToken } from "../../../src/rest/deviceAuth.js";
import {
  defaultTestEnv,
  makeOrg,
  makeTestRedis,
  makeUser,
  setupTestDb,
} from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;
const redis = makeTestRedis();
let org: Awaited<ReturnType<typeof makeOrg>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let regular: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;
let outsider: Awaited<ReturnType<typeof makeUser>>;

async function authorize(token: string, userId: string, orgId: string) {
  await redis.set(
    cliAccessKey(hashCliAccessToken(token)),
    JSON.stringify({ userId, orgId }),
    "EX",
    3600,
  );
}

beforeAll(async () => {
  testDb = await setupTestDb();
  org = await makeOrg(testDb.db);
  admin = await makeUser(testDb.db, {
    orgId: org.id,
    role: "org_admin",
    scopeType: "organization",
    scopeId: org.id,
  });
  regular = await makeUser(testDb.db, { orgId: org.id });
  member = await makeUser(testDb.db, { orgId: org.id, email: "scored@example.com" });
  const otherOrg = await makeOrg(testDb.db);
  outsider = await makeUser(testDb.db, { orgId: otherOrg.id, email: "outside@example.com" });

  const [device] = await testDb.db
    .insert(devices)
    .values({
      userId: member.id,
      orgId: org.id,
      hostname: "member-laptop",
      os: "darwin-arm64",
      agentVersion: "test",
    })
    .returning();
  const now = new Date();
  await testDb.db.insert(clientSessions).values({
    id: "cli-admin-report-session",
    deviceId: device!.id,
    userId: member.id,
    orgId: org.id,
    sourceClient: "claude-code",
    modelProvider: "claude",
    startedAt: new Date(now.getTime() - 60_000),
    lastEventAt: now,
  });
  await testDb.db.insert(clientEvents).values([
    {
      orgId: org.id,
      deviceId: device!.id,
      sessionId: "cli-admin-report-session",
      eventId: "user-1",
      role: "user",
      eventType: "message",
      timestamp: new Date(now.getTime() - 30_000),
      content: [{ type: "text", text: "Please add tests" }],
    },
    {
      orgId: org.id,
      deviceId: device!.id,
      sessionId: "cli-admin-report-session",
      eventId: "assistant-1",
      role: "assistant",
      eventType: "message",
      timestamp: new Date(now.getTime() - 20_000),
      content: [{ type: "text", text: "Added tests" }],
      inputTokens: 10,
      outputTokens: 5,
    },
  ]);

  app = Fastify({ logger: false });
  app.decorate("db", testDb.db as Database);
  await app.register(cliAdminReportRoutes(defaultTestEnv, redis));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});
beforeEach(async () => redis.flushall());

function payload(memberIdentifier: string) {
  const now = new Date();
  return {
    org: org.slug,
    member: memberIdentifier,
    period_start: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    period_end: new Date(now.getTime() + 60_000).toISOString(),
  };
}

describe("POST /v1/cli/admin/report-bundle authorization and data scope", () => {
  it("returns normalized live telemetry and the active rubric to an org admin", async () => {
    const token = "cct_admin_test";
    await authorize(token, admin.id, org.id);
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      headers: { authorization: `Bearer ${token}` },
      payload: payload(member.email),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      org: { id: org.id },
      member: { id: member.id },
      source: { session_count: 1, event_count: 2, turn_count: 1 },
    });
    expect(response.json().usage_rows).toHaveLength(1);
    expect(response.json().body_rows).toHaveLength(1);
    expect(response.json().rubric.sections.length).toBeGreaterThan(0);
    const audits = await testDb.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, admin.id),
          eq(auditLogs.targetId, member.id),
          eq(auditLogs.action, "report.cli_bundle_exported"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("rejects a valid CLI identity without report.read_org", async () => {
    const token = "cct_regular_test";
    await authorize(token, regular.id, org.id);
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      headers: { authorization: `Bearer ${token}` },
      payload: payload(member.email),
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not expose a user outside the requested organization", async () => {
    const token = "cct_admin_outside_test";
    await authorize(token, admin.id, org.id);
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      headers: { authorization: `Bearer ${token}` },
      payload: payload(outsider.email),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "member_not_found" });
  });
});
