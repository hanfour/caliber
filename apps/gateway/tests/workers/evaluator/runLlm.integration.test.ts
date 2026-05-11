/**
 * Integration tests for runLlmDeepAnalysis (Plan 4B Part 5, Task 5.2).
 *
 * Uses a real Postgres testcontainer + ioredis-mock (no real gateway server).
 * Fetch is injected via `fetchImpl` to simulate gateway loopback responses.
 *
 * Test cases:
 *   1. Happy path — Redis key + org llm_eval_enabled + valid LLM response + usage_logs row → result
 *   2. Missing Redis key — returns null
 *   3. org llm_eval_enabled=false — returns null
 *   4. Fetch 500 — returns null
 *   5. Malformed LLM JSON response — returns null
 *   6. Cost lookup doesn't materialize — returns result with costUsd=0
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  organizations,
  usageLogs,
  users,
  apiKeys,
  upstreamAccounts,
  type Database,
} from "@caliber/db";
import type { BodyRow, Report, Rubric } from "@caliber/evaluator";
import {
  runLlmDeepAnalysis,
  LLM_KEY_REDIS_PREFIX,
} from "../../../src/workers/evaluator/runLlm.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let disabledOrgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

// Shared ioredis-mock instance — flushed between tests to prevent key leakage.
const redis = new RedisMock() as unknown as Redis;

const STUB_LLM_MODEL = "claude-haiku-4-5";
const STUB_REQUEST_ID = "req-llm-deep-001";
const STUB_RAW_KEY =
  "aide-eval-aabbccddee112233445566778899aabbccddee112233445566778899aabbccddee";

// Minimal rubric for tests
const STUB_RUBRIC: Rubric = {
  name: "Test rubric",
  version: "0.1.0-test",
  locale: "en",
  sections: [
    {
      id: "quality",
      name: "Quality",
      weight: "100%",
      standard: { score: 100, label: "Standard", criteria: ["baseline"] },
      superior: { score: 120, label: "Superior", criteria: ["above"] },
      signals: [],
    },
  ],
};

// Minimal rule-based report
const STUB_RULE_REPORT: Report = {
  totalScore: 75,
  sectionScores: [
    {
      sectionId: "quality",
      name: "Quality",
      weight: 100,
      standardScore: 100,
      superiorScore: 120,
      score: 75,
      label: "Standard",
      signals: [],
    },
  ],
  signalsSummary: {
    requests: 1,
    input_tokens: 100,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost: 0.001,
    cache_read_ratio: 0,
    refusal_rate: 0,
    model_mix: { "claude-haiku-4-5": 1 },
    client_mix: {},
    model_diversity: 1,
    tool_diversity: 0,
    iteration_count: 0,
    client_mix_ratio: 0,
    body_capture_coverage: 1,
    period: { requestCount: 1, bodyCount: 1 },
  },
  dataQuality: {
    capturedRequests: 1,
    missingBodies: 0,
    truncatedBodies: 0,
    totalRequests: 1,
    coverageRatio: 1,
  },
};

// Minimal BodyRow
const STUB_BODIES: BodyRow[] = [
  {
    requestId: STUB_REQUEST_ID,
    stopReason: "end_turn",
    clientUserAgent: "test/1.0",
    clientSessionId: null,
    requestParams: null,
    responseBody: { content: [{ type: "text", text: "Hello" }] },
    requestBody: { messages: [{ role: "user", content: "test" }] },
  },
];

// Valid LLM JSON payload that parseLlmResponse will accept
const VALID_LLM_JSON = JSON.stringify({
  narrative: "Good engineering practices observed.",
  evidence: [
    {
      quote: "Hello",
      requestId: STUB_REQUEST_ID,
      rationale: "Demonstrates clear communication.",
    },
  ],
  sectionAdjustments: [
    {
      sectionId: "quality",
      adjustment: 5,
      rationale: "Above average quality.",
    },
  ],
});

// Canned Anthropic-shaped response body
const VALID_ANTHROPIC_RESPONSE = {
  id: "msg-test-123",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: VALID_LLM_JSON }],
  model: STUB_LLM_MODEL,
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 200 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeHeaders(requestId: string): Headers {
  const h = new Headers();
  h.set("x-request-id", requestId);
  h.set("content-type", "application/json");
  return h;
}

function makeFetchOk(
  requestId: string,
  responseBody: unknown = VALID_ANTHROPIC_RESPONSE,
): typeof fetch {
  return async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: makeFakeHeaders(requestId),
    });
}

function makeFetchError(status: number): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: "upstream error" }), {
      status,
      headers: new Headers({ "content-type": "application/json" }),
    });
}

/** Instant sleep for tests — avoids real 250ms delays. */
const noopSleep = async (_ms: number): Promise<void> => {};

async function seedUsageLog(
  reqId: string,
  totalCost = "0.0123456789",
): Promise<void> {
  await db.insert(usageLogs).values({
    requestId: reqId,
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
    outputCost: "0.0110000000",
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
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // Seed org (llm_eval_enabled=true, model set)
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "run-llm-test-org",
      name: "Run LLM Test Org",
      llmEvalEnabled: true,
      llmEvalModel: STUB_LLM_MODEL,
    })
    .returning();
  orgId = org!.id;

  // Seed a disabled org for test 3
  const [disabledOrg] = await db
    .insert(organizations)
    .values({
      slug: "disabled-llm-org",
      name: "Disabled LLM Org",
      llmEvalEnabled: false,
      llmEvalModel: STUB_LLM_MODEL,
    })
    .returning();
  disabledOrgId = disabledOrg!.id;

  // Seed user
  const [user] = await db
    .insert(users)
    .values({ email: "run-llm-test@example.com" })
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
      keyHash: `hash-run-llm-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "rl-test",
      name: "run-llm-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  // Flush Redis to prevent key leakage between tests (ioredis-mock shares state)
  await redis.flushall();
  // Clear usage_logs between tests
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── Helper to build base input ────────────────────────────────────────────────

function makeBaseInput(
  overrides: Partial<Parameters<typeof runLlmDeepAnalysis>[0]> = {},
) {
  return {
    db,
    redis,
    gatewayBaseUrl: "http://localhost:3002",
    orgId,
    rubric: STUB_RUBRIC,
    ruleBasedReport: STUB_RULE_REPORT,
    bodies: STUB_BODIES,
    sleepMs: noopSleep,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runLlmDeepAnalysis — integration", () => {
  it("1. happy path: Redis key + org enabled + valid response + usage_logs row → correct result", async () => {
    const reqId = "req-llm-happy-001";
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);
    await seedUsageLog(reqId, "0.0123456789");

    const result = await runLlmDeepAnalysis({
      ...makeBaseInput(),
      fetchImpl: makeFetchOk(reqId),
    });

    expect(result).not.toBeNull();
    expect(result!.narrative).toBe("Good engineering practices observed.");
    expect(result!.evidence).toHaveLength(1);
    expect(result!.evidence[0]!.requestId).toBe(STUB_REQUEST_ID);
    expect(result!.sectionAdjustments).toHaveLength(1);
    expect(result!.sectionAdjustments[0]!.adjustment).toBe(5);
    expect(result!.model).toBe(STUB_LLM_MODEL);
    expect(result!.requestId).toBe(reqId);
    expect(result!.costUsd).toBeCloseTo(0.0123456789, 8);
    expect(result!.upstreamAccountId).toBe(accountId);
  });

  it("2. missing Redis key → returns null", async () => {
    // No key set in Redis (flushed in beforeEach)
    const result = await runLlmDeepAnalysis({
      ...makeBaseInput(),
      fetchImpl: makeFetchOk("req-llm-no-redis-001"),
    });

    expect(result).toBeNull();
  });

  it("3. org llm_eval_enabled=false → returns null", async () => {
    // Set Redis key for the disabled org
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${disabledOrgId}`, STUB_RAW_KEY);

    const result = await runLlmDeepAnalysis({
      ...makeBaseInput({ orgId: disabledOrgId }),
      fetchImpl: makeFetchOk("req-llm-disabled-001"),
    });

    expect(result).toBeNull();
  });

  it("4. fetch 500 → returns null", async () => {
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);

    const result = await runLlmDeepAnalysis({
      ...makeBaseInput(),
      fetchImpl: makeFetchError(500),
    });

    expect(result).toBeNull();
  });

  it("5. malformed LLM JSON response → parseLlmResponse fails → returns null", async () => {
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);

    const malformedAnthropicResp = {
      id: "msg-bad",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "this is NOT valid json structure" }],
      model: STUB_LLM_MODEL,
    };

    const result = await runLlmDeepAnalysis({
      ...makeBaseInput(),
      fetchImpl: makeFetchOk("req-llm-malformed-001", malformedAnthropicResp),
    });

    expect(result).toBeNull();
  });

  it("6. cost lookup doesn't materialize → exhausts retries → returns result with costUsd=0", async () => {
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);
    // Do NOT seed a usage_logs row — the lookup will find nothing
    const reqId = "req-llm-no-cost-001";

    const result = await runLlmDeepAnalysis({
      ...makeBaseInput(),
      fetchImpl: makeFetchOk(reqId),
      // noopSleep already set in makeBaseInput
    });

    // Result is still returned (LLM parsing succeeded)
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(reqId);
    expect(result!.costUsd).toBe(0);
    expect(result!.upstreamAccountId).toBeNull();
  });
});
