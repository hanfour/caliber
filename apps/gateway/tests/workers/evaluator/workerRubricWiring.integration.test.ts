/**
 * Integration tests for PR3: worker wiring — evaluator worker passes `apiKeyId`
 * to the rubric resolver so per-key evaluations use the key's custom rubric.
 *
 * These tests exercise the full pipeline:
 *   enqueue job → createEvaluatorWorker processes it → evaluation_reports_by_key
 *
 * The critical RED test (T1) fails before the one-line fix in worker.ts:
 *   `resolver.resolve({ db, orgId })` omits `apiKeyId`
 *   → resolver skips key branch → falls back to platform-default
 *   → evaluation_reports_by_key.rubric_id = platform default id ≠ key rubric id
 *
 * After the fix:
 *   `resolver.resolve({ db, orgId, apiKeyId: payload.apiKeyId })`
 *   → resolver finds key rubric → rubric_id = key rubric id  (GREEN)
 *
 * Tests:
 *   T1 (RED→GREEN): per-key job WITH a key rubric → rubric_id == keyRubricId
 *   T2 (stable):    per-key job WITHOUT a key rubric → rubric_id == platformDefaultRubricId
 *   T3 (stable):    per-person job → evaluation_reports.rubric_id == platformDefaultRubricId,
 *                   evaluation_reports_by_key empty
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import type { Redis as RedisType } from "ioredis";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  apiKeys,
  evaluationReports,
  evaluationReportsByKey,
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
  createEvaluatorQueue,
  EVALUATOR_JOB_NAME,
  EVALUATOR_QUEUE_PREFIX,
  EvaluatorJobPayload,
} from "../../../src/workers/evaluator/queue.js";
import { createEvaluatorWorker } from "../../../src/workers/evaluator/worker.js";
import type { Rubric } from "@caliber/evaluator";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests
const TEST_MASTER_KEY =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

// Resolved in beforeAll from the migration-seeded platform rubric
let platformDefaultRubricVersion: string;

// Key-scoped rubric fixture (distinct name and version so we can tell it apart)
const KEY_RUBRIC: Rubric = {
  name: "Key Custom Rubric — Wiring Test",
  version: "3.0.0-key",
  locale: "en",
  sections: [
    {
      id: "interaction",
      name: "Key Interaction",
      weight: "100%",
      standard: {
        score: 100,
        label: "Standard",
        criteria: ["key standard criterion"],
      },
      superior: {
        score: 120,
        label: "Superior",
        criteria: ["key superior criterion"],
      },
      signals: [{ type: "cache_read_ratio", id: "cr", gte: 0.1 }],
    },
  ],
};

// Evaluation period
const PERIOD_START = new Date("2024-05-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-05-02T00:00:00.000Z");

// ── Containers + shared state ────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let redisContainer: StartedRedisContainer;
let redisHost: string;
let redisPort: number;

// Shared fixtures (seeded once in beforeAll)
let orgId: string;
let userId: string;
let accountId: string;
let platformDefaultRubricId: string;

// Key WITH a key-scoped rubric
let keyWithRubricId: string;
let keyRubricId: string;

// Key WITHOUT a key-scoped rubric (resolver falls back to platform default)
let keyWithoutRubricId: string;

// ioredis-mock for the evaluator's `redis` parameter (LLM key storage / facet
// cache / budget). LLM is disabled (org.llmEvalEnabled=false) so the mock only
// needs to support flushall + the facet-cache operations used during rule-based
// scoring.
const redisMock = new RedisMock() as unknown as RedisType;

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Stand up Postgres + Redis testcontainers in parallel for faster start
  [pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);

  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  redisHost = redisContainer.getHost();
  redisPort = redisContainer.getPort();

  // ── Seed org (llmEvalEnabled=false — keeps tests focused on rubric routing) ─
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "worker-rubric-wiring-test-org",
      name: "Worker Rubric Wiring Test Org",
      llmEvalEnabled: false,
    })
    .returning();
  orgId = org!.id;

  // ── Seed user ───────────────────────────────────────────────────────────────
  const [user] = await db
    .insert(users)
    .values({ email: "worker-rubric-wiring-test@example.com" })
    .returning();
  userId = user!.id;

  // ── Seed upstream account (FK needed by usage_logs) ─────────────────────────
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "worker-rubric-wiring-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  // ── Resolve platform-default rubric from migration seeds (migration 0003
  //    seeds EN/ZH-Hant/JA platform defaults; we re-use the EN one so we don't
  //    add a duplicate that would confuse the locale-picker) ──────────────────
  const platformRubric = await db
    .select({ id: rubrics.id, version: rubrics.version })
    .from(rubrics)
    .where(and(isNull(rubrics.orgId), eq(rubrics.isDefault, true), isNull(rubrics.deletedAt)))
    .limit(1)
    .then((r) => r[0]);
  if (!platformRubric) {
    throw new Error("Expected migration 0003 to seed at least one platform-default rubric");
  }
  platformDefaultRubricId = platformRubric.id;
  platformDefaultRubricVersion = platformRubric.version;

  // ── Seed api_key WITH evaluateAsProject=true (will receive a key rubric) ────
  const [keyWith] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-worker-wiring-with-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "wwk-",
      name: "wiring-key-with-rubric",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
      evaluateAsProject: true,
    })
    .returning({ id: apiKeys.id });
  keyWithRubricId = keyWith!.id;

  // ── Seed the key-scoped rubric for keyWithRubric ────────────────────────────
  const [keyRubric] = await db
    .insert(rubrics)
    .values({
      orgId,                          // denormalized from key's orgId
      apiKeyId: keyWithRubricId,      // key-scoped
      name: KEY_RUBRIC.name,
      version: KEY_RUBRIC.version,
      definition: KEY_RUBRIC as unknown,
      isDefault: false,
    })
    .returning({ id: rubrics.id });
  keyRubricId = keyRubric!.id;

  // ── Seed api_key WITHOUT a key-scoped rubric (resolver falls to platform) ───
  const [keyWithout] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-worker-wiring-without-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "wwk2-",
      name: "wiring-key-without-rubric",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
      evaluateAsProject: true,
    })
    .returning({ id: apiKeys.id });
  keyWithoutRubricId = keyWithout!.id;
}, 180_000);

afterAll(async () => {
  await pool.end();
  await Promise.all([pgContainer.stop(), redisContainer.stop()]);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports_by_key RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE evaluation_reports RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await redisMock.flushall();

  // Flush BullMQ keys from real Redis to avoid job-ID dedup interference
  const flushClient = new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  });
  await flushClient.flushall();
  await flushClient.quit();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Poll until predicate returns true or timeout expires. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Seed a usage_log attributed to a specific api key inside the evaluation window. */
async function seedUsageLog(requestId: string, forApiKeyId: string): Promise<void> {
  await db.insert(usageLogs).values({
    requestId,
    userId,
    apiKeyId: forApiKeyId,
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
    createdAt: new Date("2024-05-01T10:00:00.000Z"),
  });
}

/** Seed an encrypted request_body tied to a request_id. */
async function seedRequestBody(requestId: string): Promise<void> {
  const requestBodyEnc = encryptBody({
    masterKeyHex: TEST_MASTER_KEY,
    requestId,
    plaintext: JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello from wiring test!" }],
    }),
  });
  const responseBodyEnc = encryptBody({
    masterKeyHex: TEST_MASTER_KEY,
    requestId,
    plaintext: JSON.stringify({
      content: [{ type: "text", text: "Reply!" }],
      stop_reason: "end_turn",
    }),
  });
  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: requestBodyEnc.sealed,
    responseBodySealed: responseBodyEnc.sealed,
    stopReason: "end_turn",
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    retentionUntil: new Date("2025-01-01T00:00:00.000Z"),
  });
}

/**
 * Run a job through a fresh evaluator worker and wait until it completes.
 *
 * Creates isolated queue + worker + BullMQ Redis connection per call so tests
 * don't share BullMQ job state. The `redis` parameter for evaluation-time
 * operations (facet cache, budget, LLM key) uses an ioredis-mock since
 * llmEvalEnabled=false means no real LLM call is issued.
 *
 * NOTE: BullMQ 5.x prohibits colons in custom job IDs (the production
 * `enqueueEvaluator` format contains colons). In these tests we call
 * `queue.add` directly with a simple non-colon job ID so that BullMQ
 * validation passes. The job PAYLOAD (including apiKeyId) is unaffected —
 * which is what the worker actually reads.
 */
async function processJob(jobPayload: unknown): Promise<void> {
  const bullmqConn = new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  });

  const queue = createEvaluatorQueue({
    connection: bullmqConn,
    prefix: EVALUATOR_QUEUE_PREFIX,
    defaultJobOptions: { attempts: 1 },
  });

  const workerConn = new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  });

  const worker = createEvaluatorWorker({
    connection: workerConn,
    db,
    redis: redisMock,
    masterKeyHex: TEST_MASTER_KEY,
    gatewayBaseUrl: "http://localhost:3002",
    concurrency: 1,
  });

  worker.on("error", () => {
    // Suppress BullMQ internal error events from leaking to the test process
  });

  const validated = EvaluatorJobPayload.parse(jobPayload);
  // Use a simple UUID-based job ID — BullMQ 5.x prohibits colons in custom IDs
  const simpleJobId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await queue.add(EVALUATOR_JOB_NAME, validated, { jobId: simpleJobId, attempts: 1 });

  try {
    await waitFor(async () => {
      const counts = await queue.getJobCounts("completed", "failed");
      return (counts.completed ?? 0) + (counts.failed ?? 0) >= 1;
    }, 30_000);
  } finally {
    await worker.close();
    await workerConn.quit();
    await queue.close();
    await bullmqConn.quit();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createEvaluatorWorker — rubric wiring (PR3)", () => {
  /**
   * T1 (RED → GREEN): per-key job for a key WITH a key-scoped rubric.
   *
   * Before the fix: worker calls resolver.resolve({ db, orgId }) — no apiKeyId
   *   → resolver skips key branch → platform-default rubric is resolved
   *   → evaluation_reports_by_key.rubric_id = platformDefaultRubricId ≠ keyRubricId
   *   → assertion fails  (RED)
   *
   * After the fix: worker calls resolver.resolve({ db, orgId, apiKeyId })
   *   → resolver hits key branch → key rubric is resolved
   *   → evaluation_reports_by_key.rubric_id = keyRubricId  (GREEN)
   */
  it("T1: per-key job with a key-scoped rubric writes that key rubric to evaluation_reports_by_key", async () => {
    await seedUsageLog("req-wiring-t1-001", keyWithRubricId);
    await seedRequestBody("req-wiring-t1-001");

    await processJob({
      orgId,
      userId,
      periodStart: PERIOD_START.toISOString(),
      periodEnd: PERIOD_END.toISOString(),
      periodType: "daily",
      triggeredBy: "cron",
      triggeredByUser: null,
      apiKeyId: keyWithRubricId,
      keyNameSnapshot: "wiring-key-with-rubric",
    });

    const rows = await db.select().from(evaluationReportsByKey);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // The report must reference the KEY'S rubric, not the platform default
    expect(row.rubricId).toBe(keyRubricId);
    expect(row.rubricVersion).toBe(KEY_RUBRIC.version);
    expect(row.apiKeyId).toBe(keyWithRubricId);

    // per-person table must be empty
    const perPerson = await db.select().from(evaluationReports);
    expect(perPerson).toHaveLength(0);
  }, 60_000);

  /**
   * T2 (stable): per-key job for a key WITHOUT a key-scoped rubric.
   * Resolver falls through to platform-default at all times. Passes before and
   * after the fix — ensures the fallback chain is intact.
   */
  it("T2: per-key job without a key rubric falls back to the platform-default rubric", async () => {
    await seedUsageLog("req-wiring-t2-001", keyWithoutRubricId);
    await seedRequestBody("req-wiring-t2-001");

    await processJob({
      orgId,
      userId,
      periodStart: PERIOD_START.toISOString(),
      periodEnd: PERIOD_END.toISOString(),
      periodType: "daily",
      triggeredBy: "cron",
      triggeredByUser: null,
      apiKeyId: keyWithoutRubricId,
      keyNameSnapshot: "wiring-key-without-rubric",
    });

    const rows = await db.select().from(evaluationReportsByKey);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.rubricId).toBe(platformDefaultRubricId);
    expect(row.rubricVersion).toBe(platformDefaultRubricVersion);
    expect(row.apiKeyId).toBe(keyWithoutRubricId);
  }, 60_000);

  /**
   * T3 (stable): per-person job (no apiKeyId) → unchanged behavior.
   * Writes to evaluation_reports only; evaluation_reports_by_key stays empty.
   * Uses platform-default rubric (branch 0 skipped because no apiKeyId).
   */
  it("T3: per-person job (no apiKeyId) writes to evaluation_reports only with platform-default rubric", async () => {
    await seedUsageLog("req-wiring-t3-001", keyWithRubricId);
    await seedRequestBody("req-wiring-t3-001");

    await processJob({
      orgId,
      userId,
      periodStart: PERIOD_START.toISOString(),
      periodEnd: PERIOD_END.toISOString(),
      periodType: "daily",
      triggeredBy: "cron",
      triggeredByUser: null,
      // No apiKeyId → per-person path
    });

    // per-person table has 1 row with platform-default rubric
    const perPerson = await db.select().from(evaluationReports);
    expect(perPerson).toHaveLength(1);
    expect(perPerson[0]!.userId).toBe(userId);
    expect(perPerson[0]!.rubricId).toBe(platformDefaultRubricId);
    expect(perPerson[0]!.rubricVersion).toBe(platformDefaultRubricVersion);

    // by-key table must be empty
    const byKey = await db.select().from(evaluationReportsByKey);
    expect(byKey).toHaveLength(0);
  }, 60_000);
});
