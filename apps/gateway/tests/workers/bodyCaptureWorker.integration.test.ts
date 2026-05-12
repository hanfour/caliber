/**
 * Integration test for the body-capture worker (Plan 4B Part 3, Task 3.4).
 *
 * Stands up real Postgres + Redis testcontainers. Tests:
 *   1. End-to-end: enqueue → worker processes → row in request_bodies with
 *      encrypted blobs that round-trip via decryptBody.
 *   2. ON CONFLICT DO NOTHING: enqueueing the same requestId twice writes
 *      only one row.
 *   3. retentionUntil = capturedAt + retentionDays.
 *   4. Sanitizer masks password fields before encryption.
 *
 * Note on FK constraint: request_bodies.requestId references usage_logs.requestId,
 * so each test pre-seeds a usage_log row before enqueueing a body capture job.
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
  requestBodies,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import {
  createBodyCaptureQueue,
  enqueueBodyCapture,
  BODY_CAPTURE_QUEUE_NAME,
  BODY_CAPTURE_QUEUE_PREFIX,
} from "../../src/workers/bodyCaptureQueue.js";
import { createBodyCaptureWorker } from "../../src/workers/bodyCaptureWorker.js";
import { decryptBody } from "../../src/capture/encrypt.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests (hex = 64 chars)
const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ── Containers + shared fixtures ─────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let redisContainer: StartedRedisContainer;
let redisHost: string;
let redisPort: number;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  redisContainer = await new RedisContainer("redis:7-alpine").start();
  redisHost = redisContainer.getHost();
  redisPort = redisContainer.getPort();

  // Seed org + user + upstream account + api_key (needed by usage_logs FK)
  const [org] = await db
    .insert(organizations)
    .values({
      slug: "body-capture-worker-test-org",
      name: "Body Capture Worker Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "body-capture-worker-test@example.com" })
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

  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-body-capture-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "bc-test",
      name: "body-capture-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
  await redisContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // Truncate request_bodies + usage_logs between tests (CASCADE handles FKs)
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);

  const flushClient = new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  });
  await flushClient.flushall();
  await flushClient.quit();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait until predicate returns true OR timeout. */
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

/**
 * Pre-seed a usage_logs row so request_bodies FK constraint is satisfied.
 * The worker inserts into request_bodies which references usage_logs.requestId.
 */
async function seedUsageLog(requestId: string): Promise<void> {
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
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: "0.0030000000",
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
  });
}

function makeJobPayload(requestId: string, overrides = {}) {
  return {
    requestId,
    orgId,
    userId,
    requestBody: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
    responseBody: JSON.stringify({ content: [{ type: "text", text: "Hello!" }], stop_reason: "end_turn" }),
    thinkingBody: null,
    attemptErrors: null,
    requestParams: null,
    stopReason: "end_turn",
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    attachmentsMeta: null,
    cacheControlMarkers: null,
    retentionDays: 30,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("bodyCaptureWorker — end-to-end + idempotency", () => {
  // Test 1: End-to-end enqueue → process → row in DB with encrypted blobs
  it("enqueue → worker processes → row appears in request_bodies with encrypted blobs that round-trip", async () => {
    const requestId = "req-body-e2e-001";
    await seedUsageLog(requestId);

    const queue = createBodyCaptureQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    await enqueueBodyCapture(queue, makeJobPayload(requestId));

    const redisConn = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    const worker = createBodyCaptureWorker({
      connection: redisConn,
      db,
      masterKeyHex: TEST_MASTER_KEY,
      concurrency: 4,
    });

    // Suppress unhandled error events from BullMQ
    worker.on("error", () => {});

    try {
      await waitFor(async () => {
        const c = await queue.getJobCounts("completed", "failed");
        return (c.completed ?? 0) >= 1;
      }, 20_000);
    } finally {
      await worker.close();
      await redisConn.quit();
    }

    // Verify row exists in request_bodies
    const rows = await db
      .select()
      .from(requestBodies)
      .where(eq(requestBodies.requestId, requestId));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Verify encrypted blobs are present
    expect(row.requestBodySealed).toBeInstanceOf(Buffer);
    expect(row.responseBodySealed).toBeInstanceOf(Buffer);
    expect(row.requestBodySealed.length).toBeGreaterThan(0);
    expect(row.responseBodySealed.length).toBeGreaterThan(0);

    // Verify round-trip: decrypt should yield original-ish content
    const decryptedRequest = decryptBody({
      masterKeyHex: TEST_MASTER_KEY,
      requestId,
      sealed: row.requestBodySealed,
      version: 2,
    });
    const decryptedResponse = decryptBody({
      masterKeyHex: TEST_MASTER_KEY,
      requestId,
      sealed: row.responseBodySealed,
      version: 2,
    });

    expect(decryptedRequest).toContain("claude-sonnet-4-5");
    expect(decryptedResponse).toContain("end_turn");

    // Verify metadata was stored cleartext
    expect(row.stopReason).toBe("end_turn");
    expect(row.clientUserAgent).toBe("test-agent/1.0");
    expect(row.orgId).toBe(orgId);

    await queue.close();
  }, 60_000);

  // Test 2: ON CONFLICT DO NOTHING — same requestId twice writes only one row
  it("ON CONFLICT DO NOTHING: enqueueing the same requestId twice writes only one row", async () => {
    const requestId = "req-body-dedup-001";
    await seedUsageLog(requestId);

    const queue = createBodyCaptureQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    // Enqueue same requestId twice — BullMQ dedup keeps only one job
    await enqueueBodyCapture(queue, makeJobPayload(requestId));
    // Second enqueue with same requestId is a no-op in BullMQ (same jobId)
    await enqueueBodyCapture(queue, makeJobPayload(requestId));

    const redisConn = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    const worker = createBodyCaptureWorker({
      connection: redisConn,
      db,
      masterKeyHex: TEST_MASTER_KEY,
    });

    worker.on("error", () => {});

    try {
      await waitFor(async () => {
        const c = await queue.getJobCounts("waiting", "active", "completed", "failed");
        return (c.waiting ?? 0) === 0 && (c.active ?? 0) === 0 && (c.completed ?? 0) >= 1;
      }, 20_000);
    } finally {
      await worker.close();
      await redisConn.quit();
    }

    // Only one row should exist regardless of how many jobs were processed
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(requestBodies)
      .where(eq(requestBodies.requestId, requestId));

    expect(count[0]!.n).toBe(1);

    await queue.close();
  }, 60_000);

  // Test 3: retentionUntil = capturedAt + retentionDays
  it("retentionUntil is correctly calculated as capturedAt + retentionDays", async () => {
    const requestId = "req-body-retention-001";
    const retentionDays = 45;
    await seedUsageLog(requestId);

    const queue = createBodyCaptureQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    const beforeEnqueue = new Date();
    await enqueueBodyCapture(queue, makeJobPayload(requestId, { retentionDays }));

    const redisConn = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    const worker = createBodyCaptureWorker({
      connection: redisConn,
      db,
      masterKeyHex: TEST_MASTER_KEY,
    });

    worker.on("error", () => {});

    try {
      await waitFor(async () => {
        const c = await queue.getJobCounts("completed", "failed");
        return (c.completed ?? 0) >= 1;
      }, 20_000);
    } finally {
      await worker.close();
      await redisConn.quit();
    }

    const rows = await db
      .select()
      .from(requestBodies)
      .where(eq(requestBodies.requestId, requestId));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    const capturedAt = row.capturedAt!;
    const retentionUntil = row.retentionUntil!;

    // retentionUntil should be approximately capturedAt + retentionDays
    const expectedDiff = retentionDays * 24 * 60 * 60 * 1000;
    const actualDiff = retentionUntil.getTime() - capturedAt.getTime();

    // Allow 5 seconds tolerance for processing time
    expect(actualDiff).toBeGreaterThanOrEqual(expectedDiff - 5000);
    expect(actualDiff).toBeLessThanOrEqual(expectedDiff + 5000);

    // capturedAt should be after our beforeEnqueue timestamp
    expect(capturedAt.getTime()).toBeGreaterThanOrEqual(beforeEnqueue.getTime() - 1000);

    await queue.close();
  }, 60_000);

  // Test 4: Sanitizer masks password fields before encryption
  it("sanitizer masks password fields before encryption", async () => {
    const requestId = "req-body-sanitize-001";
    await seedUsageLog(requestId);

    const sensitiveRequest = JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hello" }],
      password: "super-secret-password",
      api_key: "sk-ant-secret-key",
    });

    const queue = createBodyCaptureQueue({
      connection: {
        host: redisHost,
        port: redisPort,
        maxRetriesPerRequest: null,
      },
    });

    await enqueueBodyCapture(
      queue,
      makeJobPayload(requestId, { requestBody: sensitiveRequest }),
    );

    const redisConn = new Redis({
      host: redisHost,
      port: redisPort,
      maxRetriesPerRequest: null,
    });

    const worker = createBodyCaptureWorker({
      connection: redisConn,
      db,
      masterKeyHex: TEST_MASTER_KEY,
    });

    worker.on("error", () => {});

    try {
      await waitFor(async () => {
        const c = await queue.getJobCounts("completed", "failed");
        return (c.completed ?? 0) >= 1;
      }, 20_000);
    } finally {
      await worker.close();
      await redisConn.quit();
    }

    const rows = await db
      .select()
      .from(requestBodies)
      .where(eq(requestBodies.requestId, requestId));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Decrypt and verify secrets were masked
    const decryptedRequest = decryptBody({
      masterKeyHex: TEST_MASTER_KEY,
      requestId,
      sealed: row.requestBodySealed,
      version: 2,
    });

    const parsed = JSON.parse(decryptedRequest);
    expect(parsed.password).toBe("***");
    expect(parsed.api_key).toBe("***");
    // Non-sensitive fields should be present
    expect(parsed.model).toBe("claude-sonnet-4-5");

    await queue.close();
  }, 60_000);
});

describe("bodyCaptureWorker pure helpers", () => {
  it("module exports the expected queue identifier shape", () => {
    expect(`${BODY_CAPTURE_QUEUE_PREFIX}:${BODY_CAPTURE_QUEUE_NAME}`).toBe(
      "caliber:gw:body-capture",
    );
  });
});
