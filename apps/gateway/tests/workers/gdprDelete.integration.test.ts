/**
 * Integration test for the GDPR delete worker (Plan 4B Part 10, Task 10.1).
 *
 * Stands up a real Postgres testcontainer. Seeds FK parent rows (orgs, users,
 * api_keys, upstreamAccounts, usage_logs, request_bodies, rubrics,
 * evaluation_reports, gdpr_delete_requests) and verifies:
 *
 *   1. Approved "bodies" scope request → executes, deletes request_bodies,
 *      leaves evaluation_reports, marks executed_at, writes audit log.
 *   2. Approved "bodies_and_reports" scope request → deletes both
 *      request_bodies and evaluation_reports.
 *   3. Unapproved request (approvedAt IS NULL) → skipped.
 *   4. Rejected request (rejectedAt IS NOT NULL) → skipped even if approvedAt set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { sql, eq } from "drizzle-orm";
import {
  organizations,
  users,
  upstreamAccounts,
  apiKeys,
  usageLogs,
  requestBodies,
  rubrics,
  evaluationReports,
  gdprDeleteRequests,
  auditLogs,
  devices,
  clientSessions,
  clientEvents,
  type Database,
} from "@caliber/db";
import { executeGdprDeletions } from "../../src/workers/gdprDelete.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Container + shared fixtures ───────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;
let rubricId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "gdpr-delete-test-org", name: "GDPR Delete Test Org" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "gdpr-delete-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "gdpr-test-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-gdpr-delete-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "gd-test",
      name: "gdpr-delete-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;

  const [rubric] = await db
    .insert(rubrics)
    .values({
      orgId,
      name: "gdpr-test-rubric",
      version: "1.0.0",
      definition: {},
      isDefault: false,
    })
    .returning({ id: rubrics.id });
  rubricId = rubric!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE gdpr_delete_requests RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE client_events RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE client_sessions RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE devices RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`,
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let seqCounter = 0;

async function seedUsageAndBody(): Promise<string> {
  seqCounter++;
  const requestId = `req-gdpr-${seqCounter}`;
  const placeholder = Buffer.from("placeholder");

  await db.insert(usageLogs).values({
    requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0001000000",
    outputCost: "0.0002000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: "0.0003000000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 100,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
  });

  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: placeholder,
    responseBodySealed: placeholder,
    retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days out
  });

  return requestId;
}

async function seedEvaluationReport(): Promise<string> {
  const periodStart = new Date("2024-03-01T00:00:00.000Z");
  const periodEnd = new Date("2024-03-02T00:00:00.000Z");

  const [report] = await db
    .insert(evaluationReports)
    .values({
      orgId,
      userId,
      teamId: null,
      periodStart,
      periodEnd,
      periodType: "daily",
      rubricId,
      rubricVersion: "1.0.0",
      totalScore: "0.8500",
      sectionScores: {},
      signalsSummary: {},
      dataQuality: {},
      triggeredBy: "cron",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReports.id });

  return report!.id;
}

async function countBodies(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM request_bodies`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function countReports(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM evaluation_reports`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function countAuditLogs(action: string): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE action = ${action}`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function countSessions(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM client_sessions`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function countEvents(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM client_events`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

async function seedTranscriptForUser(opts: {
  userId: string;
  orgId: string;
  sessionId: string;
  eventCount: number;
}): Promise<void> {
  const [device] = await db
    .insert(devices)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      hostname: `host-${opts.sessionId}`,
      os: "darwin",
      agentVersion: "0.1.0",
    })
    .returning({ id: devices.id });
  const deviceId = device!.id;

  await db.insert(clientSessions).values({
    id: opts.sessionId,
    deviceId,
    userId: opts.userId,
    orgId: opts.orgId,
    sourceClient: "claude-code",
    startedAt: new Date("2026-05-18T10:00:00Z"),
    lastEventAt: new Date("2026-05-18T10:01:00Z"),
  });

  const rows = Array.from({ length: opts.eventCount }, (_, i) => ({
    orgId: opts.orgId,
    deviceId,
    sessionId: opts.sessionId,
    eventId: `${opts.sessionId}-evt-${i}`,
    eventType: "user_message",
    timestamp: new Date("2026-05-18T10:00:00Z"),
    source: "transcript",
  }));
  await db.insert(clientEvents).values(rows);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeGdprDeletions", () => {
  it("1. approved 'bodies' scope → deletes request_bodies, leaves reports, marks executed, writes audit log", async () => {
    await seedUsageAndBody();
    await seedEvaluationReport();

    const now = new Date();
    const [req] = await db
      .insert(gdprDeleteRequests)
      .values({
        orgId,
        userId,
        scope: "bodies",
        approvedAt: now,
        approvedByUserId: userId,
      })
      .returning({ id: gdprDeleteRequests.id });
    const requestId = req!.id;

    expect(await countBodies()).toBe(1);
    expect(await countReports()).toBe(1);

    const result = await executeGdprDeletions({ db });

    expect(result.requestsProcessed).toBe(1);
    expect(result.bodiesDeleted).toBe(1);
    expect(result.reportsDeleted).toBe(0);
    expect(result.failures).toBe(0);

    // request_bodies gone, evaluation_reports intact
    expect(await countBodies()).toBe(0);
    expect(await countReports()).toBe(1);

    // executedAt set
    const [updated] = await db
      .select({ executedAt: gdprDeleteRequests.executedAt })
      .from(gdprDeleteRequests)
      .where(eq(gdprDeleteRequests.id, requestId));
    expect(updated!.executedAt).not.toBeNull();

    // audit log written
    expect(await countAuditLogs("gdpr.delete_executed")).toBe(1);
  });

  it("2. approved 'bodies_and_reports' scope → deletes both request_bodies and evaluation_reports", async () => {
    await seedUsageAndBody();
    await seedEvaluationReport();

    const now = new Date();
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies_and_reports",
      approvedAt: now,
      approvedByUserId: userId,
    });

    expect(await countBodies()).toBe(1);
    expect(await countReports()).toBe(1);

    const result = await executeGdprDeletions({ db });

    expect(result.requestsProcessed).toBe(1);
    expect(result.bodiesDeleted).toBe(1);
    expect(result.reportsDeleted).toBe(1);
    expect(result.failures).toBe(0);

    expect(await countBodies()).toBe(0);
    expect(await countReports()).toBe(0);

    expect(await countAuditLogs("gdpr.delete_executed")).toBe(1);
  });

  it("3. unapproved request (approvedAt IS NULL) → skipped", async () => {
    await seedUsageAndBody();

    // No approvedAt set — pending request
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
    });

    expect(await countBodies()).toBe(1);

    const result = await executeGdprDeletions({ db });

    // Nothing processed
    expect(result.requestsProcessed).toBe(0);
    expect(result.bodiesDeleted).toBe(0);
    expect(result.failures).toBe(0);

    // Bodies untouched
    expect(await countBodies()).toBe(1);

    // No audit log
    expect(await countAuditLogs("gdpr.delete_executed")).toBe(0);
  });

  it("4. rejected request (rejectedAt IS NOT NULL) → skipped even if approvedAt is set", async () => {
    await seedUsageAndBody();

    const now = new Date();
    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      // Both set — simulates a pathological case; rejectedAt gate must win
      approvedAt: now,
      approvedByUserId: userId,
      rejectedAt: now,
      rejectedReason: "changed mind",
    });

    expect(await countBodies()).toBe(1);

    const result = await executeGdprDeletions({ db });

    expect(result.requestsProcessed).toBe(0);
    expect(result.bodiesDeleted).toBe(0);
    expect(result.failures).toBe(0);

    // Bodies untouched
    expect(await countBodies()).toBe(1);

    expect(await countAuditLogs("gdpr.delete_executed")).toBe(0);
  });

  it("5. cascade: client_sessions for (org, user) are deleted; client_events follow via FK ON DELETE CASCADE", async () => {
    await seedUsageAndBody();
    await seedTranscriptForUser({
      userId,
      orgId,
      sessionId: `gdpr-sess-${Date.now()}`,
      eventCount: 4,
    });

    expect(await countSessions()).toBe(1);
    expect(await countEvents()).toBe(4);

    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      approvedAt: new Date(),
      approvedByUserId: userId,
    });

    const result = await executeGdprDeletions({ db });

    expect(result.clientSessionsDeleted).toBe(1);
    expect(result.clientEventsDeleted).toBe(4);
    expect(await countSessions()).toBe(0);
    expect(await countEvents()).toBe(0);

    // Audit log carries the per-request cascade counts.
    const rows = await db.execute<{ metadata: Record<string, number> }>(sql`
      SELECT metadata FROM audit_logs
      WHERE action = 'gdpr.delete_executed'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.metadata.clientSessionsDeleted).toBe(1);
    expect(rows.rows[0]!.metadata.clientEventsDeleted).toBe(4);
  });

  it("6. tenant isolation: other users' sessions in the same org are NOT affected", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: `gdpr-other-${Date.now()}@example.com` })
      .returning();
    const otherUserId = otherUser!.id;

    await seedTranscriptForUser({
      userId,
      orgId,
      sessionId: `target-sess-${Date.now()}`,
      eventCount: 3,
    });
    await seedTranscriptForUser({
      userId: otherUserId,
      orgId,
      sessionId: `other-sess-${Date.now()}`,
      eventCount: 2,
    });

    expect(await countSessions()).toBe(2);
    expect(await countEvents()).toBe(5);

    await db.insert(gdprDeleteRequests).values({
      orgId,
      userId,
      scope: "bodies",
      approvedAt: new Date(),
      approvedByUserId: userId,
    });

    const result = await executeGdprDeletions({ db });

    expect(result.clientSessionsDeleted).toBe(1);
    expect(result.clientEventsDeleted).toBe(3);
    expect(await countSessions()).toBe(1);
    expect(await countEvents()).toBe(2);
  });
});
