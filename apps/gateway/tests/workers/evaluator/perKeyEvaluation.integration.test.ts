/**
 * Integration tests for per-key evaluation pipeline (PR3).
 *
 * Verifies that when `apiKeyId` is passed to `runEvaluation`:
 *   1. Usage logs / bodies are scoped to that key only (cross-key isolation).
 *   2. A row is written to `evaluation_reports_by_key`, NOT `evaluation_reports`.
 *   3. Two distinct keys of the same user produce two distinct rows.
 *   4. Upsert is idempotent — re-running keyA yields no duplicate row.
 *   5. Per-person `evaluation_reports` is untouched (byte-identical per-person path).
 *
 * Uses a real Postgres testcontainer (via @testcontainers/postgresql) and
 * ioredis-mock so no external services are required.
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
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  apiKeys,
  evaluationReports,
  evaluationReportsByKey,
  organizations,
  requestBodies,
  rubrics,
  teams,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { encryptBody } from "../../../src/capture/encrypt.js";
import { runEvaluation } from "../../../src/workers/evaluator/runEvaluation.js";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests (hex = 64 chars)
const TEST_MASTER_KEY =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

const STUB_RUBRIC_VERSION = platformDefaultRubric.version;

// Evaluation period window
const PERIOD_START = new Date("2024-04-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-04-02T00:00:00.000Z");

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let rubricId: string;
let teamAId: string;

// Two api_keys belonging to the same user
let keyAId: string;
let keyBId: string;

const redis = new RedisMock() as unknown as Redis;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed org (llmEvalEnabled=false — per-key tests use rule-based only to keep
  // the test focused on the fetch-scope and upsert-routing assertions)
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "per-key-eval-test-org",
      name: "Per Key Eval Test Org",
      llmEvalEnabled: false,
    })
    .returning();
  orgId = org!.id;

  // Seed a team for keyA (so teamId derivation from api_keys.team_id is exercised)
  const [teamA] = await db
    .insert(teams)
    .values({ orgId, name: "Team Alpha", slug: "team-alpha" })
    .returning();
  teamAId = teamA!.id;

  // Seed user
  const [user] = await db
    .insert(users)
    .values({ email: "per-key-eval-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed upstream account (FK needed by usage_logs)
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "per-key-eval-test-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  // Seed two api_keys for the same user
  // keyA is in teamA; keyB has no team
  const [keyA] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      teamId: teamAId,
      keyHash: `hash-per-key-a-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "pka-",
      name: "project-key-alpha",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
      evaluateAsProject: true,
    })
    .returning({ id: apiKeys.id });
  keyAId = keyA!.id;

  const [keyB] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      teamId: null,
      keyHash: `hash-per-key-b-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "pkb-",
      name: "project-key-beta",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
      evaluateAsProject: true,
    })
    .returning({ id: apiKeys.id });
  keyBId = keyB!.id;

  // Seed rubric (FK needed by evaluation_reports_by_key)
  const [rubric] = await db
    .insert(rubrics)
    .values({
      orgId: null,
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

beforeEach(async () => {
  // Clear transient tables between tests
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports_by_key RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await redis.flushall();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopSleep = async (_ms: number): Promise<void> => {};

function makeKeyInput(
  apiKeyId: string,
  keyNameSnapshot: string,
  teamId?: string | null,
  overrides: Partial<Parameters<typeof runEvaluation>[0]> = {},
) {
  return {
    db,
    redis,
    masterKeyHex: TEST_MASTER_KEY,
    gatewayBaseUrl: "http://localhost:3002",
    orgId,
    userId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    periodType: "daily" as const,
    rubric: platformDefaultRubric,
    rubricId,
    rubricVersion: STUB_RUBRIC_VERSION,
    triggeredBy: "cron" as const,
    triggeredByUser: null,
    llmEvalEnabled: false,
    sleepMs: noopSleep,
    apiKeyId,
    keyNameSnapshot,
    ...overrides,
  };
}

/**
 * Seed a usage_log row attributed to the given apiKeyId.
 * Uses a timestamp inside the evaluation window.
 */
async function seedUsageLog(
  requestId: string,
  apiKeyId: string,
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
    createdAt: new Date("2024-04-01T10:00:00.000Z"),
  });
}

async function seedRequestBody(requestId: string): Promise<void> {
  const requestBodyStr = JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "Hello from per-key test!" }],
  });
  const responseBodyStr = JSON.stringify({
    content: [{ type: "text", text: "Reply!" }],
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
    stopReason: "end_turn",
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    retentionUntil: new Date("2024-10-01T00:00:00.000Z"),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runEvaluation — per-key pipeline (PR3)", () => {
  it("1. per-key: writes to evaluation_reports_by_key, NOT evaluation_reports", async () => {
    await seedUsageLog("req-pka-001", keyAId);
    await seedRequestBody("req-pka-001");

    const result = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId),
    );

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();

    // evaluation_reports_by_key has 1 row
    const byKeyRows = await db.select().from(evaluationReportsByKey);
    expect(byKeyRows).toHaveLength(1);
    const row = byKeyRows[0]!;
    expect(row.apiKeyId).toBe(keyAId);
    expect(row.keyNameSnapshot).toBe("project-key-alpha");
    expect(row.userId).toBe(userId);
    expect(row.orgId).toBe(orgId);
    // teamId sourced from api_keys.team_id (not NULL for keyA)
    expect(row.teamId).toBe(teamAId);

    // evaluation_reports (per-person) is untouched
    const perPersonRows = await db.select().from(evaluationReports);
    expect(perPersonRows).toHaveLength(0);
  });

  it("2. two keys of same user → two distinct rows, per-person table empty", async () => {
    // Seed 2 usage logs + bodies for keyA
    await seedUsageLog("req-pka-101", keyAId);
    await seedRequestBody("req-pka-101");
    await seedUsageLog("req-pka-102", keyAId);
    await seedRequestBody("req-pka-102");

    // Seed 2 usage logs + bodies for keyB
    await seedUsageLog("req-pkb-101", keyBId);
    await seedRequestBody("req-pkb-101");
    await seedUsageLog("req-pkb-102", keyBId);
    await seedRequestBody("req-pkb-102");

    // Evaluate keyA
    const resultA = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId),
    );
    // Evaluate keyB
    const resultB = await runEvaluation(
      makeKeyInput(keyBId, "project-key-beta", null),
    );

    expect(resultA.skipped).toBe(false);
    expect(resultB.skipped).toBe(false);

    // Two distinct rows in evaluation_reports_by_key
    const byKeyRows = await db
      .select()
      .from(evaluationReportsByKey)
      .orderBy(evaluationReportsByKey.keyNameSnapshot);
    expect(byKeyRows).toHaveLength(2);

    const rowA = byKeyRows.find((r) => r.apiKeyId === keyAId)!;
    const rowB = byKeyRows.find((r) => r.apiKeyId === keyBId)!;

    expect(rowA).toBeDefined();
    expect(rowA.keyNameSnapshot).toBe("project-key-alpha");
    expect(rowA.teamId).toBe(teamAId);

    expect(rowB).toBeDefined();
    expect(rowB.keyNameSnapshot).toBe("project-key-beta");
    expect(rowB.teamId).toBeNull();

    // Returned report IDs are distinct
    expect(resultA.reportId).not.toBe(resultB.reportId);

    // per-person table still empty
    const perPerson = await db.select().from(evaluationReports);
    expect(perPerson).toHaveLength(0);
  });

  it("3. cross-key isolation — keyA report only counts keyA bodies", async () => {
    // Seed 2 requests for keyA and 3 for keyB
    for (const id of ["req-iso-a1", "req-iso-a2"]) {
      await seedUsageLog(id, keyAId);
      await seedRequestBody(id);
    }
    for (const id of ["req-iso-b1", "req-iso-b2", "req-iso-b3"]) {
      await seedUsageLog(id, keyBId);
      await seedRequestBody(id);
    }

    const resultA = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId),
    );

    // keyA report must only see 2 requests
    const rowA = await db
      .select()
      .from(evaluationReportsByKey)
      .where(eq(evaluationReportsByKey.id, resultA.reportId!))
      .then((r) => r[0]!);

    const dataQuality = rowA.dataQuality as {
      totalRequests: number;
      capturedRequests: number;
    };
    expect(dataQuality.totalRequests).toBe(2);
    expect(dataQuality.capturedRequests).toBe(2);

    const signalsSummary = rowA.signalsSummary as { requests: number };
    expect(signalsSummary.requests).toBe(2);
  });

  it("4. re-run keyA upserts without duplicate (idempotent)", async () => {
    await seedUsageLog("req-rerun-a1", keyAId);
    await seedRequestBody("req-rerun-a1");

    // First run
    const result1 = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId),
    );
    expect(result1.reportId).toBeTruthy();

    // Second run (same key, same period)
    const result2 = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId, {
        triggeredBy: "admin_rerun",
      }),
    );
    expect(result2.reportId).toBeTruthy();

    // Only 1 row in the table (unique index on userId, apiKeyId, periodStart, periodType)
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(evaluationReportsByKey)
      .where(eq(evaluationReportsByKey.apiKeyId, keyAId));
    expect(count[0]!.n).toBe(1);

    // The surviving row reflects the latest run
    const rows = await db
      .select()
      .from(evaluationReportsByKey)
      .where(eq(evaluationReportsByKey.apiKeyId, keyAId));
    expect(rows[0]!.triggeredBy).toBe("admin_rerun");
  });

  it("5. per-person path unaffected — no apiKeyId → writes evaluation_reports only", async () => {
    await seedUsageLog("req-perperson-001", keyAId);
    await seedRequestBody("req-perperson-001");

    // No apiKeyId → per-person path
    const result = await runEvaluation({
      db,
      redis,
      masterKeyHex: TEST_MASTER_KEY,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      userId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      periodType: "daily",
      rubric: platformDefaultRubric,
      rubricId,
      rubricVersion: STUB_RUBRIC_VERSION,
      triggeredBy: "cron",
      triggeredByUser: null,
      llmEvalEnabled: false,
      sleepMs: noopSleep,
    });

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();

    // Per-person table has 1 row
    const perPerson = await db.select().from(evaluationReports);
    expect(perPerson).toHaveLength(1);
    expect(perPerson[0]!.userId).toBe(userId);

    // By-key table is empty
    const byKey = await db.select().from(evaluationReportsByKey);
    expect(byKey).toHaveLength(0);
  });

  it("6. per-key empty window → skipped=true, no row written", async () => {
    // No usage_logs seeded for this key in the window
    const result = await runEvaluation(
      makeKeyInput(keyAId, "project-key-alpha", teamAId),
    );

    expect(result.skipped).toBe(true);
    expect(result.reportId).toBeNull();

    const byKey = await db.select().from(evaluationReportsByKey);
    expect(byKey).toHaveLength(0);
  });
});
