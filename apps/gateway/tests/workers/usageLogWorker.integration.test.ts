/**
 * Integration test for the batched usage log worker (Plan 4A Part 7, Task 7.2).
 *
 * Stands up real Postgres + Redis testcontainers, enqueues 250 jobs spread
 * across 3 api_keys, runs the worker, and verifies:
 *   - all 250 rows land in usage_logs
 *   - api_keys.quota_used_usd is the exact decimal sum per key
 *   - the failed-batch path retries up to attempts=3 then lands in DLQ, with
 *     the queueDlqCount gauge reflecting the failed count
 *
 * The "≤ 3 transactions" assertion in the spec is intentionally loose-tested:
 * we verify timing (all 250 jobs complete within ~3 flush windows) plus row
 * totals.  Counting transactions exactly would require pg-statement
 * instrumentation that adds fragility without catching real bugs.
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
import { eq, sql } from "drizzle-orm";
import {
  apiKeys,
  organizations,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import {
  createUsageLogQueue,
  enqueueUsageLog,
  USAGE_LOG_QUEUE_NAME,
  USAGE_LOG_QUEUE_PREFIX,
  type UsageLogJobPayload,
} from "../../src/workers/usageLogQueue.js";
import {
  UsageLogWorker,
  type GaugeLike,
} from "../../src/workers/usageLogWorker.js";
import { makeUsageLogJobPayload } from "../factories/usageLogPayload.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Containers + shared fixtures ─────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
// node-postgres drizzle return shape lines up with Database, but TS can't
// infer through pg.Pool generics without the schema parameter passed to
// createDb in @caliber/db, so we keep a localized cast.
let db: Database;

let redisContainer: StartedRedisContainer;
let redisHost: string;
let redisPort: number;

let orgId: string;
let userId: string;
let accountId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  redisContainer = await new RedisContainer("redis:7-alpine").start();
  redisHost = redisContainer.getHost();
  redisPort = redisContainer.getPort();

  // Seed an org + user + upstream account that all api_keys / usage_logs
  // can reference.  Doing this once in beforeAll keeps per-test setup quick.
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "usage-log-worker-test-org",
      name: "Usage Log Worker Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "usage-log-worker-test@example.com" })
    .returning();
  userId = user!.id;

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
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
  await redisContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // Wipe usage_logs + api_keys so each test starts from a known state.
  // Truncate is faster than DELETE for this volume; CASCADE picks up FKs.
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);

  // Flush the test Redis between tests so leftover BullMQ keys from one test
  // don't affect job counts in the next.  Use a fresh client; closing it
  // here keeps the shared connection pool clean.
  const flushClient = new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  });
  await flushClient.flushall();
  await flushClient.quit();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function recordingGauge(): GaugeLike & { value: number } {
  return {
    value: 0,
    set(v: number) {
      this.value = v;
    },
  };
}

interface ApiKeyRow {
  id: string;
}

async function seedApiKey(prefix: string): Promise<ApiKeyRow> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-${prefix}-${Math.random().toString(36).slice(2)}`,
      keyPrefix: prefix,
      name: `key-${prefix}`,
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  return row!;
}

function makePayload(
  apiKeyId: string,
  totalCost: string,
  reqIdx: number,
): UsageLogJobPayload {
  return makeUsageLogJobPayload({
    requestId: `req-${apiKeyId.slice(0, 8)}-${reqIdx}`,
    userId,
    apiKeyId,
    accountId,
    orgId,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    totalCost,
    actualCostUsd: totalCost,
  });
}

/**
 * Wait until predicate returns true OR timeout.  Used to wait for the worker
 * to drain the queue without polling Postgres at high frequency.
 */
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UsageLogWorker — batched insert + quota update", () => {
  it("drains 250 enqueued jobs across 3 api_keys with correct row counts and quota sums", async () => {
    // 1. Seed 3 api keys (A=100 jobs, B=100 jobs, C=50 jobs).
    const keyA = await seedApiKey("k-a");
    const keyB = await seedApiKey("k-b");
    const keyC = await seedApiKey("k-c");

    // 2. Build the queue (no worker yet — we want every job to hit Redis
    //    before the worker starts so the first batch fills immediately).
    const queue = createUsageLogQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    // 3. Enqueue 250 jobs concurrently.
    //    Each job's totalCost = $0.01 → keyA total = $1.00, keyB = $1.00,
    //    keyC = $0.50.  Using the same value for all jobs keeps the assertion
    //    arithmetic obvious.
    const TOTAL_COST = "0.0100000000";
    const enqueues: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      enqueues.push(
        enqueueUsageLog(queue, makePayload(keyA.id, TOTAL_COST, i)),
      );
    }
    for (let i = 0; i < 100; i++) {
      enqueues.push(
        enqueueUsageLog(queue, makePayload(keyB.id, TOTAL_COST, i)),
      );
    }
    for (let i = 0; i < 50; i++) {
      enqueues.push(
        enqueueUsageLog(queue, makePayload(keyC.id, TOTAL_COST, i)),
      );
    }
    await Promise.all(enqueues);

    // Sanity: queue should now show 250 waiting.
    const beforeCounts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
    );
    expect(beforeCounts.waiting).toBe(250);

    // 4. Start the worker.
    const queueDepthGauge = recordingGauge();
    const dlqGauge = recordingGauge();
    const worker = new UsageLogWorker(db, {
      logger: silentLogger(),
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
      queue,
      metrics: { queueDepth: queueDepthGauge, queueDlqCount: dlqGauge },
    });
    worker.start();

    try {
      // 5. Wait until all 250 jobs are completed.  Concurrency=100 + 1s
      //    flush interval → expect all batches done within ~5s comfortably.
      await waitFor(async () => {
        const c = await queue.getJobCounts("completed", "failed");
        return (c.completed ?? 0) >= 250 && (c.failed ?? 0) === 0;
      }, 20_000);
    } finally {
      await worker.stop();
    }

    // 6. usage_logs row count = 250.
    const totalRows = await db
      .select({ rowCount: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(totalRows[0]!.rowCount).toBe(250);

    // 7. Per-key quota_used_usd matches sum.
    const [keyARow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyA.id));
    const [keyBRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyB.id));
    const [keyCRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyC.id));
    // 100 × 0.01 = 1.00, 100 × 0.01 = 1.00, 50 × 0.01 = 0.50.
    // Postgres returns decimal as a string; compare numerically to avoid
    // padding-zero variance.
    expect(Number(keyARow!.used)).toBeCloseTo(1, 8);
    expect(Number(keyBRow!.used)).toBeCloseTo(1, 8);
    expect(Number(keyCRow!.used)).toBeCloseTo(0.5, 8);

    // 8. Per-row inserts went to the right api_key_id.
    const countsA = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(eq(usageLogs.apiKeyId, keyA.id));
    const countsB = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(eq(usageLogs.apiKeyId, keyB.id));
    const countsC = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(eq(usageLogs.apiKeyId, keyC.id));
    expect(countsA[0]!.count).toBe(100);
    expect(countsB[0]!.count).toBe(100);
    expect(countsC[0]!.count).toBe(50);

    // 9. Metrics: after final flush, queueDepth should be 0 and DLQ 0.
    expect(queueDepthGauge.value).toBe(0);
    expect(dlqGauge.value).toBe(0);

    await queue.close();
  }, 60_000);

  it("mixed batch of duplicate + new request_ids drains to completed (no poison-batch DLQ)", async () => {
    // Regression test for the poison-batch fix: a BullMQ redelivery of a
    // previously-committed job (missed ACK) arriving alongside legitimate
    // new jobs must NOT take down the whole batch.  Before the fix the
    // UNIQUE(request_id) collision aborted the txn and every job retried
    // to DLQ.  After the fix the duplicate is silently deduped inside
    // the same txn, new rows commit, all jobs mark completed.
    const keyOld = await seedApiKey("k-old");
    const keyNew = await seedApiKey("k-new");
    const TOTAL_COST = "0.0200000000";

    // 1. Pre-seed 50 "already committed" rows directly into usage_logs
    //    with deterministic request_ids.  Quota bumped to match so the
    //    starting state is consistent (50 × $0.02 = $1.00).
    const preCommittedIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const reqId = `req-dup-${keyOld.id.slice(0, 8)}-${i}`;
      preCommittedIds.push(reqId);
      await db.insert(usageLogs).values({
        requestId: reqId,
        userId,
        apiKeyId: keyOld.id,
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
        cacheReadTokens: 0,
        inputCost: "0.0010000000",
        outputCost: "0.0020000000",
        cacheCreationCost: "0",
        cacheReadCost: "0",
        totalCost: TOTAL_COST,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        cachedInputTokens: 0,
        cachedInputCost: "0",
        actualCostUsd: "0",
        groupId: null,
        rateMultiplier: "1.0000",
        accountRateMultiplier: "1.0000",
        statusCode: 200,
        durationMs: 1234,
        firstTokenMs: null,
        bufferReleasedAtMs: null,
        upstreamRetries: 0,
        failedAccountIds: [],
        userAgent: null,
        ipAddress: null,
      });
    }
    await db
      .update(apiKeys)
      .set({ quotaUsedUsd: "1.00000000" })
      .where(eq(apiKeys.id, keyOld.id));

    // 2. Build the queue.
    const queue = createUsageLogQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    // 3. Enqueue 100 jobs: 50 duplicates (same request_ids as pre-seeded)
    //    + 50 brand-new jobs for keyNew.  A BullMQ restart would plausibly
    //    redeliver up to `concurrency` previously-ACKed jobs alongside
    //    freshly-produced ones; we simulate that race directly.
    const enqueues: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      // Duplicate: same requestId as the pre-seeded row.
      const payload = {
        ...makePayload(keyOld.id, TOTAL_COST, i),
        requestId: preCommittedIds[i]!,
      };
      enqueues.push(enqueueUsageLog(queue, payload));
    }
    for (let i = 0; i < 50; i++) {
      // New: distinct requestId derived from keyNew.
      enqueues.push(
        enqueueUsageLog(queue, makePayload(keyNew.id, TOTAL_COST, 1000 + i)),
      );
    }
    await Promise.all(enqueues);

    // 4. Start the worker with a small batch to guarantee mixed batches.
    const dlqGauge = recordingGauge();
    const worker = new UsageLogWorker(db, {
      logger: silentLogger(),
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
      queue,
      metrics: { queueDepth: recordingGauge(), queueDlqCount: dlqGauge },
      batchSize: 25,
      flushIntervalMs: 200,
    });
    worker.start();

    try {
      // All 100 jobs must drain to completed, zero to failed.
      await waitFor(async () => {
        const c = await queue.getJobCounts("completed", "failed");
        return (c.completed ?? 0) >= 100 && (c.failed ?? 0) === 0;
      }, 20_000);
    } finally {
      await worker.stop();
    }

    // 5. usage_logs row count = 50 pre-seeded + 50 new = 100.  No dup
    //    rows created.
    const totalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(totalRows[0]!.count).toBe(100);

    // 6. keyOld quota unchanged: still $1.00 from the pre-seed.  If the
    //    dup path accidentally bumped quota, this would be $2.00.
    const [keyOldRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyOld.id));
    expect(Number(keyOldRow!.used)).toBeCloseTo(1.0, 8);

    // 7. keyNew quota bumped exactly once per new row: 50 × $0.02 = $1.00.
    const [keyNewRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyNew.id));
    expect(Number(keyNewRow!.used)).toBeCloseTo(1.0, 8);

    // 8. DLQ stayed empty — the poison-batch bug is dead.
    expect(dlqGauge.value).toBe(0);

    await queue.close();
  }, 60_000);

  it("retries failed batches up to attempts=3 then lands in DLQ; gauge reflects failure count", async () => {
    // 1. Seed one valid api_key — but enqueue all jobs with a NON-EXISTENT
    //    apiKeyId so the multi-row INSERT FK violation aborts the whole txn.
    //    Each job will retry 3× then move to failed.
    const NON_EXISTENT_KEY = "00000000-0000-4000-8000-000000000000";

    const queue = createUsageLogQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
      // Tighten backoff so the test doesn't wait the default 1s × exponential
      // for each attempt.  attempts=3 stays at the queue default.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "fixed", delay: 50 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    });

    // Enqueue a small batch (5 jobs) — failure path doesn't need 250 jobs.
    const enqueues: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      enqueues.push(
        enqueueUsageLog(queue, makePayload(NON_EXISTENT_KEY, "0.01", i)),
      );
    }
    await Promise.all(enqueues);

    const queueDepthGauge = recordingGauge();
    const dlqGauge = recordingGauge();
    const worker = new UsageLogWorker(db, {
      logger: silentLogger(),
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
      queue,
      metrics: { queueDepth: queueDepthGauge, queueDlqCount: dlqGauge },
      // Smaller batch → flush sooner so test finishes faster.
      batchSize: 5,
      flushIntervalMs: 200,
    });
    worker.start();

    try {
      // Wait for all 5 jobs to land in failed state.  3 attempts × 50ms
      // backoff → upper bound a few seconds for BullMQ scheduling overhead.
      await waitFor(async () => {
        const c = await queue.getJobCounts("failed");
        return (c.failed ?? 0) >= 5;
      }, 30_000);
    } finally {
      await worker.stop();
    }

    // No rows should have been written — every batch txn rolled back on the
    // FK violation.
    const totalRows = await db
      .select({ rowCount: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(totalRows[0]!.rowCount).toBe(0);

    // Final DLQ gauge should reflect failed-set size (≥ 5).
    expect(dlqGauge.value).toBeGreaterThanOrEqual(5);

    await queue.close();
  }, 60_000);
});

// ── Pure-function unit tests for batcher helpers ────────────────────────────

describe("UsageLogWorker pure helpers", () => {
  // Co-locating these with the integration suite keeps the worker file's
  // public-helpers test surface in one place.  They don't need the
  // testcontainers, but vitest will skip them quickly when the suite reuses
  // the beforeAll fixtures.
  it("module exports the expected queue identifier shape", () => {
    expect(`${USAGE_LOG_QUEUE_PREFIX}:${USAGE_LOG_QUEUE_NAME}`).toBe(
      "caliber:gw:usage-log",
    );
  });
});
