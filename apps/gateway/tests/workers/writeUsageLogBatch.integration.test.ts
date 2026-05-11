/**
 * Integration test for the shared `writeUsageLogBatch` helper (Plan 4A
 * Part 7, Task 7.3).
 *
 * The worker integration test (`usageLogWorker.integration.test.ts`)
 * already exercises this code path via the BullMQ batcher.  The cases here
 * pin the helper as a STANDALONE callable, because Task 7.3's inline
 * fallback in `enqueueUsageLog` calls it directly (no worker, no Redis).
 *
 * Coverage:
 *   - single-payload write commits with the correct row + quota update
 *   - duplicate request_id is silently deduped by ON CONFLICT DO NOTHING;
 *     the txn commits, quota is NOT re-bumped for the duplicate, and
 *     new rows in the same mixed batch still commit and bump quota
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
  organizations,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import type { UsageLogJobPayload } from "../../src/workers/usageLogQueue.js";
import { makeUsageLogJobPayload } from "../factories/usageLogPayload.js";
import { writeUsageLogBatch } from "../../src/workers/writeUsageLogBatch.js";

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
let userId: string;
let accountId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "write-usage-log-batch-test-org",
      name: "writeUsageLogBatch Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "write-usage-log-batch-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-upstream-wulb",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedApiKey(prefix: string): Promise<{ id: string }> {
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
  requestId: string,
): UsageLogJobPayload {
  return makeUsageLogJobPayload({
    requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    totalCost,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("writeUsageLogBatch — standalone helper", () => {
  it("inserts a single payload and bumps quota_used_usd in one txn", async () => {
    const key = await seedApiKey("k-single");
    const payload = makePayload(key.id, "0.0420000000", "req-single-1");

    await writeUsageLogBatch(db, [payload]);

    // Row landed in usage_logs with the right request_id + cost.
    const rows = await db
      .select({
        requestId: usageLogs.requestId,
        totalCost: usageLogs.totalCost,
        apiKeyId: usageLogs.apiKeyId,
      })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, "req-single-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKeyId).toBe(key.id);
    expect(Number(rows[0]!.totalCost)).toBeCloseTo(0.042, 8);

    // Quota bumped.
    const [keyRow] = await db
      .select({ used: apiKeys.quotaUsedUsd, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id));
    expect(Number(keyRow!.used)).toBeCloseTo(0.042, 8);
    // last_used_at was set by the UPDATE (NOW()).
    expect(keyRow!.lastUsedAt).not.toBeNull();
  });

  it("is a no-op for an empty payload list", async () => {
    // Empty input must not open a txn or touch any table.
    await writeUsageLogBatch(db, []);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(rows[0]!.count).toBe(0);
  });

  it("dedups duplicate request_id via ON CONFLICT DO NOTHING (txn commits, quota not re-bumped)", async () => {
    // Exercises the poison-batch fix: a duplicate request_id must NOT
    // abort the txn.  A downstream retry (e.g., BullMQ lost ACK after a
    // prior commit) should silently no-op for the duplicate row and let
    // any other rows in the same batch commit.  The quota bump must
    // happen exactly once across both calls.
    const key = await seedApiKey("k-dup");
    const payload = makePayload(key.id, "0.0100000000", "req-dup-1");

    await writeUsageLogBatch(db, [payload]);
    await expect(writeUsageLogBatch(db, [payload])).resolves.toBeUndefined();

    // Only one row persisted; the duplicate was dropped.
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, "req-dup-1"));
    expect(rows[0]!.count).toBe(1);

    // Quota bumped exactly once — not twice.
    const [keyRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id));
    expect(Number(keyRow!.used)).toBeCloseTo(0.01, 8);
  });

  it("mixed batch of new + duplicate request_ids: new rows commit, duplicates are no-ops, quota bumped only for new", async () => {
    // This is the real poison-batch scenario: a batch contains a
    // previously-committed job (duplicate from a missed ACK) alongside
    // legitimate new jobs.  Before the fix, the UNIQUE collision aborted
    // the whole txn and ALL jobs eventually landed in DLQ.  With ON
    // CONFLICT DO NOTHING, the new rows still commit and the duplicate
    // is silently skipped.
    const keyA = await seedApiKey("k-mix-a");
    const keyB = await seedApiKey("k-mix-b");
    const keyD = await seedApiKey("k-mix-d");

    // First batch: A, B, C (all new, C shares keyA with A).  Seed three
    // rows so the quota post-state for each key is deterministic.
    const payloadA = makePayload(keyA.id, "0.0100000000", "req-mix-A");
    const payloadB = makePayload(keyB.id, "0.0200000000", "req-mix-B");
    const payloadC = makePayload(keyA.id, "0.0300000000", "req-mix-C");
    await writeUsageLogBatch(db, [payloadA, payloadB, payloadC]);

    // Second batch: A (duplicate), B (duplicate), D (new).  Must commit
    // cleanly and only bump quota for D's key.
    const payloadD = makePayload(keyD.id, "0.0400000000", "req-mix-D");
    await expect(
      writeUsageLogBatch(db, [payloadA, payloadB, payloadD]),
    ).resolves.toBeUndefined();

    // Four unique rows total (A, B, C, D) — no duplicates written.
    const totalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(totalRows[0]!.count).toBe(4);

    // keyA quota = A ($0.01) + C ($0.03) = $0.04 — NOT bumped again.
    const [keyARow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyA.id));
    expect(Number(keyARow!.used)).toBeCloseTo(0.04, 8);

    // keyB quota = B ($0.02) — NOT bumped again.
    const [keyBRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyB.id));
    expect(Number(keyBRow!.used)).toBeCloseTo(0.02, 8);

    // keyD quota = D ($0.04) — bumped exactly once (new row in 2nd batch).
    const [keyDRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyD.id));
    expect(Number(keyDRow!.used)).toBeCloseTo(0.04, 8);
  });

  it("whole-batch duplicates: txn commits with no quota update and no new rows", async () => {
    // Edge case: every payload in the batch is a duplicate.  The insert
    // returns zero rows, so the grouping step short-circuits and no
    // UPDATE runs.  The txn still commits cleanly.
    const key = await seedApiKey("k-all-dup");
    const payload1 = makePayload(key.id, "0.0100000000", "req-all-dup-1");
    const payload2 = makePayload(key.id, "0.0200000000", "req-all-dup-2");

    await writeUsageLogBatch(db, [payload1, payload2]);

    // Replay both payloads — both should be silently deduped.
    await expect(
      writeUsageLogBatch(db, [payload1, payload2]),
    ).resolves.toBeUndefined();

    const totalRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(totalRows[0]!.count).toBe(2);

    // Quota bumped once (from the first call), not twice.
    const [keyRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id));
    expect(Number(keyRow!.used)).toBeCloseTo(0.03, 8);
  });
});
