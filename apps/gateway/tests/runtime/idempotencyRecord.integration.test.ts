/**
 * Integration test for writeIdempotencyRecord (Task 8, §4.5).
 *
 * Stands up a real Postgres testcontainer, migrates the schema, seeds parent
 * FK rows (org / user / two api keys A and B), then verifies:
 *   1. Inserts a row keyed by (apiKeyId, requestKey) with correct field values,
 *      expires_at = createdAt + ttlSec.
 *   2. ttlSec=0 → no row inserted.
 *   3. Conflict (same apiKeyId + requestKey) → single row refreshed to 2nd
 *      call (internalRequestId, cost, createdAt all updated).
 *   4. Different api keys, same requestKey → two distinct rows.
 *   5. Never throws on a failing db (stub whose .insert throws synchronously).
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
import {
  writeIdempotencyRecord,
  type IdempotencyRecordPayload,
} from "../../src/runtime/idempotencyRecord.js";

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
    .values({ slug: "idem-record-test-org", name: "Idempotency Record Test Org" })
    .returning();
  orgId = org!.id;

  // Seed one user
  const [user] = await db
    .insert(users)
    .values({ email: "idem-record-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed two api keys (A and B) for composite-key isolation tests
  const [keyA] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-idem-record-a-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "ir-tst-a",
      name: "idem-record-test-key-a",
    })
    .returning({ id: apiKeys.id });
  apiKeyIdA = keyA!.id;

  const [keyB] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-idem-record-b-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "ir-tst-b",
      name: "idem-record-test-key-b",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePayload(apiKeyId: string, overrides: Partial<IdempotencyRecordPayload> = {}): IdempotencyRecordPayload {
  return {
    apiKeyId,
    orgId,
    userId,
    requestId: "internal-req-1",
    requestedModel: "claude-3-haiku-20240307",
    surface: "messages",
    platform: "anthropic",
    statusCode: 200,
    totalCost: "0.0000000100",
    actualCostUsd: "0.0000000100",
    ...overrides,
  };
}

/** Fetch the row for (apiKeyId, requestKey), or undefined if absent. */
async function fetchRow(apiKeyId: string, requestKey: string) {
  const rows = await db
    .select()
    .from(idempotencyRecords)
    .where(
      sql`api_key_id = ${apiKeyId} AND request_id = ${requestKey}`,
    );
  return rows[0];
}

/** Settle wait for the fire-and-forget write (used for absence/count assertions). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Poll for a row to appear (and optionally satisfy a predicate), up to ~1s.
 * Robust against fire-and-forget timing under a slow/cold testcontainer —
 * preferred over a fixed sleep for "row should exist" assertions.
 */
async function waitForRow(
  apiKeyId: string,
  requestKey: string,
  predicate?: (row: NonNullable<Awaited<ReturnType<typeof fetchRow>>>) => boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof fetchRow>>>> {
  for (let i = 0; i < 50; i++) {
    const row = await fetchRow(apiKeyId, requestKey);
    if (row && (!predicate || predicate(row))) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`row (${apiKeyId}, ${requestKey}) did not appear within ~1s`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("writeIdempotencyRecord", () => {
  it("inserts a row with correct fields and computed expires_at", async () => {
    const fixedNow = new Date("2025-01-01T00:00:00.000Z");
    const ttlSec = 3600;
    const expectedExpiresAt = new Date(fixedNow.getTime() + ttlSec * 1000);

    const payload = makePayload(apiKeyIdA);

    writeIdempotencyRecord({
      db,
      requestKey: "client-req-1",
      ttlSec,
      payload,
      now: () => fixedNow,
    });

    const row = await waitForRow(apiKeyIdA, "client-req-1");
    expect(row).toBeDefined();
    expect(row!.apiKeyId).toBe(apiKeyIdA);
    expect(row!.requestId).toBe("client-req-1");
    expect(row!.internalRequestId).toBe(payload.requestId);
    expect(row!.orgId).toBe(orgId);
    expect(row!.userId).toBe(userId);
    expect(row!.requestedModel).toBe(payload.requestedModel);
    expect(row!.surface).toBe(payload.surface);
    expect(row!.platform).toBe(payload.platform);
    expect(row!.statusCode).toBe(payload.statusCode);
    // Postgres decimal returns a string
    expect(parseFloat(row!.totalCost)).toBeCloseTo(parseFloat(payload.totalCost), 10);
    expect(parseFloat(row!.actualCostUsd)).toBeCloseTo(parseFloat(payload.actualCostUsd), 10);
    expect(row!.createdAt.toISOString()).toBe(fixedNow.toISOString());
    expect(row!.expiresAt.toISOString()).toBe(expectedExpiresAt.toISOString());
  });

  it("ttlSec=0 → no row inserted", async () => {
    writeIdempotencyRecord({
      db,
      requestKey: "client-req-ttl0",
      ttlSec: 0,
      payload: makePayload(apiKeyIdA),
    });

    await flush();

    const row = await fetchRow(apiKeyIdA, "client-req-ttl0");
    expect(row).toBeUndefined();
  });

  it("conflict: same (apiKeyId, requestKey) written twice → single row refreshed to 2nd call", async () => {
    const t1 = new Date("2025-01-01T00:00:00.000Z");
    const t2 = new Date("2025-01-01T01:00:00.000Z");
    const ttlSec = 3600;

    const firstPayload = makePayload(apiKeyIdA, {
      requestId: "internal-req-first",
      totalCost: "0.0000000001",
      actualCostUsd: "0.0000000001",
    });

    const secondPayload = makePayload(apiKeyIdA, {
      requestId: "internal-req-second",
      totalCost: "0.0000000099",
      actualCostUsd: "0.0000000099",
    });

    writeIdempotencyRecord({
      db,
      requestKey: "shared-req-key",
      ttlSec,
      payload: firstPayload,
      now: () => t1,
    });

    await waitForRow(apiKeyIdA, "shared-req-key");

    writeIdempotencyRecord({
      db,
      requestKey: "shared-req-key",
      ttlSec,
      payload: secondPayload,
      now: () => t2,
    });

    // Wait until the row reflects the SECOND call before the count assertion.
    await waitForRow(
      apiKeyIdA,
      "shared-req-key",
      (r) => r.internalRequestId === secondPayload.requestId,
    );

    // Exactly one row
    const allRows = await db
      .select()
      .from(idempotencyRecords)
      .where(sql`api_key_id = ${apiKeyIdA} AND request_id = 'shared-req-key'`);
    expect(allRows).toHaveLength(1);

    const row = allRows[0]!;
    // Should reflect second call
    expect(row.internalRequestId).toBe(secondPayload.requestId);
    expect(parseFloat(row.totalCost)).toBeCloseTo(parseFloat(secondPayload.totalCost), 10);
    expect(parseFloat(row.actualCostUsd)).toBeCloseTo(parseFloat(secondPayload.actualCostUsd), 10);
    expect(row.createdAt.toISOString()).toBe(t2.toISOString());
    expect(row.expiresAt.toISOString()).toBe(new Date(t2.getTime() + ttlSec * 1000).toISOString());
  });

  it("different api keys, same requestKey → two distinct rows", async () => {
    const ttlSec = 3600;

    writeIdempotencyRecord({
      db,
      requestKey: "multi-key-req",
      ttlSec,
      payload: makePayload(apiKeyIdA),
    });

    writeIdempotencyRecord({
      db,
      requestKey: "multi-key-req",
      ttlSec,
      payload: makePayload(apiKeyIdB),
    });

    const rowA = await waitForRow(apiKeyIdA, "multi-key-req");
    const rowB = await waitForRow(apiKeyIdB, "multi-key-req");
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowA!.apiKeyId).toBe(apiKeyIdA);
    expect(rowB!.apiKeyId).toBe(apiKeyIdB);
  });

  it("never throws on a failing db (stub whose .insert throws synchronously)", () => {
    const brokenDb = {
      insert: () => {
        throw new Error("db is broken");
      },
    } as unknown as Database;

    expect(() =>
      writeIdempotencyRecord({
        db: brokenDb,
        requestKey: "any-key",
        ttlSec: 3600,
        payload: makePayload(apiKeyIdA),
      }),
    ).not.toThrow();
  });

  it("never surfaces an async rejection (insert chain rejects)", async () => {
    const rejectingDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.reject(new Error("async db failure")),
        }),
      }),
    } as unknown as Database;

    // Must not throw synchronously...
    expect(() =>
      writeIdempotencyRecord({
        db: rejectingDb,
        requestKey: "async-fail-key",
        ttlSec: 3600,
        payload: makePayload(apiKeyIdA),
      }),
    ).not.toThrow();

    // ...and the rejected promise must be swallowed (no unhandledRejection).
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toBeUndefined();
  });
});
