/**
 * Integration test for the body retention purge cron (Plan 4B Part 3, Task 3.6).
 *
 * Stands up real Postgres testcontainer. Seeds request_bodies rows with various
 * retention_until timestamps and verifies:
 *   1. Overdue rows are deleted; future-dated rows survive.
 *   2. Correct deleted count is returned.
 *   3. lagHours is computed from the oldest overdue row.
 *   4. Idempotent: a second call has deleted=0 and lagHours=null.
 *
 * Note on FK constraint: request_bodies.request_id references usage_logs.request_id,
 * so each row requires a seeded usage_log row first.
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
import { sql } from "drizzle-orm";
import {
  apiKeys,
  organizations,
  requestBodies,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { purgeExpiredBodies } from "../../src/workers/bodyPurge.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Containers + shared fixtures ─────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  // One org + user + upstream account + api_key shared across all tests
  const [org] = await db
    .insert(organizations)
    .values({ slug: "body-purge-test-org", name: "Body Purge Test Org" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "body-purge-test@example.com" })
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
      keyHash: `hash-body-purge-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "bp-test",
      name: "body-purge-test-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

let seqCounter = 0;

async function seedRequestBody(
  retentionUntil: Date,
  suffix?: string,
): Promise<string> {
  seqCounter++;
  const requestId = `req-purge-${seqCounter}-${suffix ?? "x"}`;

  // Insert usage_log first to satisfy FK
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

  // Minimal placeholder blobs (bytea)
  const placeholder = Buffer.from("placeholder");

  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: placeholder,
    responseBodySealed: placeholder,
    retentionUntil,
  });

  return requestId;
}

/** Returns the count of request_bodies rows currently in the DB. */
async function countBodies(): Promise<number> {
  const rows = await db.execute(
    sql`SELECT COUNT(*)::int as cnt FROM request_bodies`,
  );
  return (rows.rows[0] as { cnt: number }).cnt;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("purgeExpiredBodies", () => {
  it("1. purges overdue rows and leaves future-dated rows intact", async () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

    await seedRequestBody(pastDate, "past");
    await seedRequestBody(futureDate, "future");

    expect(await countBodies()).toBe(2);

    const result = await purgeExpiredBodies({ db });

    expect(result.deleted).toBe(1);
    expect(await countBodies()).toBe(1);

    // Remaining row should be the future-dated one
    const remaining = await db.execute(
      sql`SELECT retention_until FROM request_bodies`,
    );
    const retentionUntil = new Date(
      (remaining.rows[0] as { retention_until: string }).retention_until,
    );
    expect(retentionUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it("2. returns correct deleted count for multiple overdue rows", async () => {
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago

    await seedRequestBody(pastDate, "a");
    await seedRequestBody(pastDate, "b");
    await seedRequestBody(pastDate, "c");

    const result = await purgeExpiredBodies({ db });

    expect(result.deleted).toBe(3);
    expect(await countBodies()).toBe(0);
  });

  it("3. computes lagHours from the oldest overdue row", async () => {
    // Seed two overdue rows: one 1h ago, one 3h ago
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

    await seedRequestBody(oneHourAgo, "lag-1h");
    await seedRequestBody(threeHoursAgo, "lag-3h");

    const result = await purgeExpiredBodies({ db });

    expect(result.lagHours).not.toBeNull();
    // oldest overdue is ~3h ago; allow ±0.1h tolerance for test execution time
    expect(result.lagHours!).toBeGreaterThan(2.9);
    expect(result.lagHours!).toBeLessThan(3.1);
  });

  it("4. idempotent: second call has deleted=0 and lagHours=null", async () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000);
    await seedRequestBody(pastDate, "idem");

    const first = await purgeExpiredBodies({ db });
    expect(first.deleted).toBe(1);

    const second = await purgeExpiredBodies({ db });
    expect(second.deleted).toBe(0);
    expect(second.lagHours).toBeNull();
  });
});
