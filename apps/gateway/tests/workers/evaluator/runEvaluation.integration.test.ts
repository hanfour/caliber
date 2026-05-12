/**
 * Integration tests for runEvaluation (Plan 4B Part 5, Task 5.3).
 *
 * Uses a real Postgres testcontainer + ioredis-mock + fake fetch to exercise
 * the orchestrator end-to-end without standing up a real gateway server.
 *
 * Test cases:
 *   1. Skipped when empty window — no usage rows → skipped=true, no report, no LLM attempt
 *   2. Rule-only when llmEvalEnabled=false — LLM not attempted
 *   3. Rule-only when coverage < 0.5 — LLM skipped, rule-based report written
 *   4. Full flow happy path — llmEvalEnabled + coverage >= 0.5, fake fetch valid → report has LLM fields
 *   5. LLM failure graceful — fake fetch 500 → report written rule-based only, llm columns NULL
 *   6. Rerun upsert preserves FK integrity — run twice → only 1 row; unique index holds
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
  organizations,
  requestBodies,
  rubrics,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { encryptBody } from "../../../src/capture/encrypt.js";
import { runEvaluation, LLM_MIN_COVERAGE_RATIO } from "../../../src/workers/evaluator/runEvaluation.js";
import { LLM_KEY_REDIS_PREFIX } from "../../../src/workers/evaluator/runLlm.js";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests (hex = 64 chars)
const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const STUB_RUBRIC_VERSION = platformDefaultRubric.version;
const STUB_LLM_MODEL = "claude-haiku-4-5";
const STUB_RAW_KEY =
  "caliber-eval-aabbccddee112233445566778899aabbccddee112233445566778899aabbccddee";
const LLM_REQUEST_ID = "req-llm-eval-orch-001";

// Period window used across tests
const PERIOD_START = new Date("2024-03-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-03-02T00:00:00.000Z");

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;
let rubricId: string;

// Shared ioredis-mock — flushed between tests to prevent key leakage
const redis = new RedisMock() as unknown as Redis;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed org with LLM eval enabled + model set
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "run-evaluation-test-org",
      name: "Run Evaluation Test Org",
      llmEvalEnabled: true,
      llmEvalModel: STUB_LLM_MODEL,
    })
    .returning();
  orgId = org!.id;

  // Seed user
  const [user] = await db
    .insert(users)
    .values({ email: "run-evaluation-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed upstream account (FK needed by usage_logs)
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "eval-test-upstream",
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
      keyHash: `hash-run-eval-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "rev-test",
      name: "run-evaluation-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;

  // Seed rubric (FK needed by evaluation_reports)
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
    sql`TRUNCATE TABLE evaluation_reports RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  // Flush Redis to prevent key leakage
  await redis.flushall();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Instant sleep for tests — avoids real 250ms delays. */
const noopSleep = async (_ms: number): Promise<void> => {};

function makeBaseInput(
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
    llmEvalEnabled: true,
    sleepMs: noopSleep,
    ...overrides,
  };
}

async function seedUsageLog(
  requestId: string,
  opts: { totalCost?: string; createdAt?: Date } = {},
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
    totalCost: opts.totalCost ?? "0.0031000000",
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
    createdAt: opts.createdAt ?? new Date("2024-03-01T10:00:00.000Z"),
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
    retentionUntil: new Date("2024-09-01T00:00:00.000Z"),
  });
}

/** Seed a usage_log row specifically for the LLM cost lookup (the loopback call). */
async function seedLlmCostLog(
  requestId: string,
  totalCost = "0.0050000000",
): Promise<void> {
  await db.insert(usageLogs).values({
    requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: STUB_LLM_MODEL,
    upstreamModel: STUB_LLM_MODEL,
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0040000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost,
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 800,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
    // Use a timestamp outside the eval window to avoid polluting coverage counts
    createdAt: new Date("2024-03-01T23:59:00.000Z"),
  });
}

// Valid LLM JSON payload that parseLlmResponse will accept
const VALID_LLM_JSON = JSON.stringify({
  narrative: "Good engineering practices observed.",
  evidence: [
    {
      quote: "Hello",
      requestId: "req-eval-body-001",
      rationale: "Demonstrates clear communication.",
    },
  ],
  sectionAdjustments: [],
});

// Canned Anthropic-shaped response body
const VALID_ANTHROPIC_RESPONSE = {
  id: "msg-eval-test-001",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: VALID_LLM_JSON }],
  model: STUB_LLM_MODEL,
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 200 },
};

function makeFetchOk(
  requestId: string,
  responseBody: unknown = VALID_ANTHROPIC_RESPONSE,
): typeof fetch {
  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("content-type", "application/json");
  return async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers,
    });
}

function makeFetchError(status: number): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: "upstream error" }), {
      status,
      headers: new Headers({ "content-type": "application/json" }),
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runEvaluation — integration", () => {
  it("1. empty window → skipped=true, no report inserted, no LLM attempt", async () => {
    // No usage_logs seeded
    const result = await runEvaluation(makeBaseInput({ llmEvalEnabled: true }));

    expect(result.skipped).toBe(true);
    expect(result.reportId).toBeNull();
    expect(result.totalScore).toBe(0);
    expect(result.llmAttempted).toBe(false);
    expect(result.llmSucceeded).toBe(false);
    expect(result.llmCostUsd).toBe(0);

    // Confirm nothing was inserted into DB
    const rows = await db.select().from(evaluationReports);
    expect(rows).toHaveLength(0);
  });

  it("2. rule-only when llmEvalEnabled=false → report written, LLM not attempted", async () => {
    const requestId = "req-eval-no-llm-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    const result = await runEvaluation(
      makeBaseInput({ llmEvalEnabled: false }),
    );

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();
    expect(result.llmAttempted).toBe(false);
    expect(result.llmSucceeded).toBe(false);
    expect(result.llmCostUsd).toBe(0);

    // Verify LLM columns are NULL in DB
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, result.reportId!));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.llmNarrative).toBeNull();
    expect(row.llmModel).toBeNull();
    expect(row.llmCostUsd).toBeNull();
  });

  it(`3. rule-only when coverage < ${LLM_MIN_COVERAGE_RATIO} → LLM skipped, report written without LLM columns`, async () => {
    // Seed usage log but NO bodies → coverageRatio = 0 (below 0.5 threshold)
    const requestId = "req-eval-low-coverage-001";
    await seedUsageLog(requestId);
    // Intentionally NOT seeding request_bodies

    // Set Redis key so LLM would run if the gate allowed it
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);

    const result = await runEvaluation(
      makeBaseInput({
        llmEvalEnabled: true,
        fetchImpl: makeFetchOk(LLM_REQUEST_ID),
      }),
    );

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();
    expect(result.llmAttempted).toBe(false);
    expect(result.llmSucceeded).toBe(false);

    // Verify LLM columns are NULL in DB
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, result.reportId!));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.llmNarrative).toBeNull();
    expect(rows[0]!.llmModel).toBeNull();
  });

  it("4. full flow happy path → report has both rule-based + LLM fields", async () => {
    const requestId = "req-eval-body-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    // Seed the LLM cost lookup row
    await seedLlmCostLog(LLM_REQUEST_ID, "0.0050000000");

    // Set Redis key so the LLM call can proceed
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);

    const result = await runEvaluation(
      makeBaseInput({
        llmEvalEnabled: true,
        fetchImpl: makeFetchOk(LLM_REQUEST_ID),
      }),
    );

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();
    expect(result.llmAttempted).toBe(true);
    expect(result.llmSucceeded).toBe(true);
    expect(result.llmCostUsd).toBeCloseTo(0.005, 8);

    // Verify LLM columns are populated in DB
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, result.reportId!));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.llmNarrative).toBe("Good engineering practices observed.");
    expect(row.llmModel).toBe(STUB_LLM_MODEL);
    expect(Number(row.llmCostUsd)).toBeCloseTo(0.005, 8);
    expect(row.llmCalledAt).toBeInstanceOf(Date);
    // Rule-based fields also present
    expect(Number(row.totalScore)).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(row.sectionScores)).toBe(true);
  });

  it("5. LLM failure graceful → fetch 500 → report written rule-based only, llm columns NULL", async () => {
    const requestId = "req-eval-llm-fail-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    // Set Redis key so LLM is attempted
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);

    const result = await runEvaluation(
      makeBaseInput({
        llmEvalEnabled: true,
        fetchImpl: makeFetchError(500),
      }),
    );

    expect(result.skipped).toBe(false);
    expect(result.reportId).toBeTruthy();
    expect(result.llmAttempted).toBe(true);
    expect(result.llmSucceeded).toBe(false);
    expect(result.llmCostUsd).toBe(0);

    // Verify LLM columns are NULL in DB even though rule-based row exists
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.id, result.reportId!));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.llmNarrative).toBeNull();
    expect(row.llmModel).toBeNull();
    expect(row.llmCostUsd).toBeNull();
    // But rule-based fields are present
    expect(Number(row.totalScore)).toBeGreaterThanOrEqual(0);
  });

  it("6. rerun upsert preserves FK integrity → run twice → 1 row, unique index holds", async () => {
    const requestId = "req-eval-rerun-001";
    await seedUsageLog(requestId);
    await seedRequestBody(requestId);

    // First run — cron triggered, no LLM
    const result1 = await runEvaluation(
      makeBaseInput({ llmEvalEnabled: false, triggeredBy: "cron" }),
    );
    expect(result1.skipped).toBe(false);
    expect(result1.reportId).toBeTruthy();

    // Second run — admin rerun, no LLM
    const result2 = await runEvaluation(
      makeBaseInput({ llmEvalEnabled: false, triggeredBy: "admin_rerun" }),
    );
    expect(result2.skipped).toBe(false);
    expect(result2.reportId).toBeTruthy();

    // Count rows — unique index on (userId, periodStart, periodType) must hold
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, userId));

    expect(count[0]!.n).toBe(1);

    // The surviving row reflects the second run's metadata
    const rows = await db
      .select()
      .from(evaluationReports)
      .where(eq(evaluationReports.userId, userId));
    expect(rows[0]!.triggeredBy).toBe("admin_rerun");
    // Both runs produce valid report data
    expect(Number(rows[0]!.totalScore)).toBeGreaterThanOrEqual(0);
  });
});
