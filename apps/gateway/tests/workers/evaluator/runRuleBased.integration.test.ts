/**
 * Integration tests for runRuleBased + upsertEvaluationReport
 * (Plan 4B Part 4, Task 4.2; updated for Task 5.3 refactor).
 *
 * Stands up a real Postgres testcontainer. Tests call `runRuleBased` directly
 * (no Redis/BullMQ needed — the worker layer is trivially thin and covered
 * elsewhere). Where DB persistence is needed, tests call `upsertEvaluationReport`
 * explicitly — mirroring what `runEvaluation` does in production.
 *
 * Test cases:
 *   1. Empty window       — no usage rows → skipped=true, no DB insert
 *   2. Happy path         — seed usage+bodies → scores → upserts report
 *   3. Upsert on rerun    — run twice → only 1 row in DB
 *   4. Missing bodies     — usage rows exist but no bodies → coverageRatio=0
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
import { eq, sql } from "drizzle-orm";
import {
  apiKeys,
  evaluationReports,
  organizations,
  requestBodies,
  rubrics,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { encryptBody } from "../../../src/capture/encrypt.js";
import {
  runRuleBased,
  upsertEvaluationReport,
} from "../../../src/workers/evaluator/runRuleBased.js";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests (hex = 64 chars)
const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Stub rubric config (mirrors what worker.ts passes)
const STUB_RUBRIC_VERSION = platformDefaultRubric.version;

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;
let rubricId: string;

// Period window used across tests
const PERIOD_START = new Date("2024-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-01-02T00:00:00.000Z");

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed org
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "run-rule-based-test-org",
      name: "Run Rule Based Test Org",
    })
    .returning();
  orgId = org!.id;

  // Seed user
  const [user] = await db
    .insert(users)
    .values({ email: "run-rule-based-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed upstream account (FK needed by usage_logs)
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  // Seed api key (FK needed by usage_logs)
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-run-rule-based-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "rrb-test",
      name: "run-rule-based-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;

  // Seed rubric (FK needed by evaluation_reports)
  const [rubric] = await db
    .insert(rubrics)
    .values({
      orgId: null, // platform-level rubric
      name: platformDefaultRubric.name,
      version: STUB_RUBRIC_VERSION,
      definition: platformDefaultRubric as unknown,
      isDefault: true,
    })
    .returning({ id: rubrics.id });
  rubricId = rubric!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // Clear evaluation_reports, request_bodies, usage_logs between tests
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRuleBasedInput() {
  return {
    db,
    masterKeyHex: TEST_MASTER_KEY,
    orgId,
    userId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    rubric: platformDefaultRubric,
  };
}

function makeUpsertInput(
  report: Parameters<typeof upsertEvaluationReport>[0]["report"],
  overrides: Partial<Parameters<typeof upsertEvaluationReport>[0]> = {},
) {
  return {
    db,
    orgId,
    userId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    periodType: "daily" as const,
    rubricId,
    rubricVersion: STUB_RUBRIC_VERSION,
    triggeredBy: "cron" as const,
    triggeredByUser: null,
    report,
    llm: null,
    ...overrides,
  };
}

async function seedUsageLog(
  requestId: string,
  createdAt: Date = new Date("2024-01-01T10:00:00.000Z"),
): Promise<void> {
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
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 50,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0.0001000000",
    totalCost: "0.0031000000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 1000,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
    createdAt,
  });
}

async function seedRequestBody(requestId: string): Promise<void> {
  const requestBodyStr = JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hello!" }],
  });
  const responseBodyStr = JSON.stringify({
    content: [{ type: "text", text: "Hi there!" }],
    stop_reason: "end_turn",
  });

  const requestBodyEnc = encryptBody({
    masterKeyHex: TEST_MASTER_KEY,
    requestId,
    plaintext: requestBodyStr,
  });
  const responseBodyEnc = encryptBody({
    masterKeyHex: TEST_MASTER_KEY,
    requestId,
    plaintext: responseBodyStr,
  });

  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: requestBodyEnc.sealed,
    responseBodySealed: responseBodyEnc.sealed,
    cipherVersion: requestBodyEnc.version,
    stopReason: "end_turn",
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    retentionUntil: new Date("2024-07-01T00:00:00.000Z"),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runRuleBased — integration", () => {
  it("1. empty window → returns skipped=true, no evaluation_reports row inserted", async () => {
    // No usage_logs seeded for this user+period
    const result = await runRuleBased(makeRuleBasedInput());

    expect(result.skipped).toBe(true);
    expect(result.bodies).toHaveLength(0);
    expect(result.report.dataQuality.totalRequests).toBe(0);
    expect(result.report.dataQuality.capturedRequests).toBe(0);
    expect(result.report.dataQuality.coverageRatio).toBe(0);

    // Confirm nothing was inserted (no upsert called when skipped)
    const rows = await db.select().from(evaluationReports);
    expect(rows).toHaveLength(0);
  });

  it("2. happy path → seeds usage+bodies → scores → upserts evaluation_reports row via upsertEvaluationReport", async () => {
    const requestId = "req-rule-happy-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    const result = await runRuleBased(makeRuleBasedInput());

    expect(result.skipped).toBe(false);
    expect(result.bodies).toHaveLength(1);
    expect(typeof result.report.totalScore).toBe("number");
    expect(result.report.dataQuality.totalRequests).toBe(1);
    expect(result.report.dataQuality.capturedRequests).toBe(1);
    expect(result.report.dataQuality.coverageRatio).toBe(1);

    // Persist via upsertEvaluationReport (what runEvaluation does in production)
    const reportId = await upsertEvaluationReport(
      makeUpsertInput(result.report),
    );

    expect(reportId).toBeTruthy();

    // Verify row exists in DB
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, reportId!));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(userId);
    expect(row.orgId).toBe(orgId);
    expect(row.periodType).toBe("daily");
    expect(row.rubricId).toBe(rubricId);
    expect(row.rubricVersion).toBe(STUB_RUBRIC_VERSION);
    expect(row.triggeredBy).toBe("cron");
    expect(row.triggeredByUser).toBeNull();
    expect(Number(row.totalScore)).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(row.sectionScores)).toBe(true);
    expect(row.dataQuality).toBeTruthy();
  });

  it("3. upsert on rerun → run twice → only 1 row in DB, second replaces first", async () => {
    const requestId = "req-rule-rerun-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    // First run
    const result1 = await runRuleBased(makeRuleBasedInput());
    expect(result1.skipped).toBe(false);
    const reportId1 = await upsertEvaluationReport(
      makeUpsertInput(result1.report, { triggeredBy: "cron" }),
    );
    expect(reportId1).toBeTruthy();

    // Second run — same period, same user, should upsert not insert
    const result2 = await runRuleBased(makeRuleBasedInput());
    expect(result2.skipped).toBe(false);
    const reportId2 = await upsertEvaluationReport(
      makeUpsertInput(result2.report, { triggeredBy: "admin_rerun" }),
    );
    expect(reportId2).toBeTruthy();

    // Only 1 row should exist
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, userId));

    expect(count[0]!.n).toBe(1);

    // The row should reflect the second run's triggeredBy
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, userId));
    expect(rows[0]!.triggeredBy).toBe("admin_rerun");
  });

  it("4. missing bodies → usage rows exist but no bodies → coverageRatio=0, report still upserted", async () => {
    const requestId = "req-rule-nobody-001";
    await seedUsageLog(requestId);
    // Intentionally NOT seeding request_bodies

    const result = await runRuleBased(makeRuleBasedInput());

    expect(result.skipped).toBe(false);
    expect(result.bodies).toHaveLength(0);
    expect(result.report.dataQuality.totalRequests).toBe(1);
    expect(result.report.dataQuality.capturedRequests).toBe(0);
    expect(result.report.dataQuality.coverageRatio).toBe(0);
    expect(result.report.dataQuality.missingBodies).toBe(1);

    // Persist via upsertEvaluationReport
    const reportId = await upsertEvaluationReport(
      makeUpsertInput(result.report),
    );
    expect(reportId).toBeTruthy();

    // Verify row was inserted
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, reportId!));
    expect(rows).toHaveLength(1);
  });
});
