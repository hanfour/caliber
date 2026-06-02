/**
 * Integration test for purgeExpiredIdempotencyRecords (Task 7).
 *
 * Stands up a real Postgres testcontainer, migrates the schema, seeds parent
 * FK rows (org / user / two api keys A and B), then verifies:
 *   1. Only expired rows are deleted; fresh rows survive.
 *   2. Composite-key scoping: (A, "x") expired but (B, "x") fresh → only A deleted.
 *   3. Cutoff boundary: expires_at <= cutoff is inclusive (equal timestamp is deleted).
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
  organizations,
  users,
  apiKeys,
  idempotencyRecords,
  type Database,
} from "@caliber/db";
import { purgeExpiredIdempotencyRecords } from "../../src/workers/idempotencyPurge.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Postgres container ────────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

// Shared parent FK rows
let orgId: string;
let userId: string;
let apiKeyIdA: string;
let apiKeyIdB: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });

  // Seed one org
  const [org] = await db
    .insert(organizations)
    .values({ slug: "idem-purge-test-org", name: "Idempotency Purge Test Org" })
    .returning();
  orgId = org!.id;

  // Seed one user
  const [user] = await db
    .insert(users)
    .values({ email: "idem-purge-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed two api keys (A and B) for composite-key isolation tests
  const [keyA] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-idem-purge-a-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "ip-tst-a",
      name: "idem-purge-test-key-a",
    })
    .returning({ id: apiKeys.id });
  apiKeyIdA = keyA!.id;

  const [keyB] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-idem-purge-b-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "ip-tst-b",
      name: "idem-purge-test-key-b",
    })
    .returning({ id: apiKeys.id });
  apiKeyIdB = keyB!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
}, 30_000);

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE idempotency_records RESTART IDENTITY CASCADE`,
  );
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function seedIdempotencyRecord(
  apiKeyId: string,
  requestId: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(idempotencyRecords).values({
    apiKeyId,
    requestId,
    internalRequestId: `int-${requestId}`,
    orgId,
    userId,
    requestedModel: "claude-3-haiku-20240307",
    surface: "messages",
    platform: "anthropic",
    statusCode: 200,
    totalCost: "0",
    actualCostUsd: "0",
    expiresAt,
  });
}

/** Returns true if a row with the given (apiKeyId, requestId) exists. */
async function rowExists(
  apiKeyId: string,
  requestId: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT 1 FROM idempotency_records WHERE api_key_id = ${apiKeyId} AND request_id = ${requestId}`,
  );
  return (rows.rows?.length ?? 0) > 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("purgeExpiredIdempotencyRecords", () => {
  it("deletes only expired rows; returns count", async () => {
    const T = new Date();
    const expired = new Date(T.getTime() - 1000); // T - 1s
    const fresh = new Date(T.getTime() + 60_000); // T + 60s

    await seedIdempotencyRecord(apiKeyIdA, "x", expired);
    await seedIdempotencyRecord(apiKeyIdA, "y", fresh);

    const result = await purgeExpiredIdempotencyRecords({ db, now: () => T });

    expect(result.deleted).toBe(1);
    expect(await rowExists(apiKeyIdA, "x")).toBe(false);
    expect(await rowExists(apiKeyIdA, "y")).toBe(true);
  });

  it("composite-key: A expired request_id=x, B fresh request_id=x → only A deleted", async () => {
    const T = new Date();
    const expired = new Date(T.getTime() - 1000); // T - 1s
    const fresh = new Date(T.getTime() + 60_000); // T + 60s

    // Both keys share the same request_id "x"
    await seedIdempotencyRecord(apiKeyIdA, "x", expired);
    await seedIdempotencyRecord(apiKeyIdB, "x", fresh);

    const result = await purgeExpiredIdempotencyRecords({ db, now: () => T });

    expect(result.deleted).toBe(1);
    expect(await rowExists(apiKeyIdA, "x")).toBe(false); // A's row deleted
    expect(await rowExists(apiKeyIdB, "x")).toBe(true); // B's row survives
  });

  it("injected-cutoff boundary: expires_at === cutoff is deleted (inclusive <=)", async () => {
    const T = new Date();
    const atCutoff = new Date(T.getTime()); // expires_at == cutoff
    const afterCutoff = new Date(T.getTime() + 1000); // expires_at == cutoff + 1s

    await seedIdempotencyRecord(apiKeyIdA, "eq", atCutoff);
    await seedIdempotencyRecord(apiKeyIdA, "gt", afterCutoff);

    const result = await purgeExpiredIdempotencyRecords({ db, now: () => T });

    expect(result.deleted).toBe(1);
    expect(await rowExists(apiKeyIdA, "eq")).toBe(false); // exactly at cutoff → deleted
    expect(await rowExists(apiKeyIdA, "gt")).toBe(true); // after cutoff → survives
  });
});
