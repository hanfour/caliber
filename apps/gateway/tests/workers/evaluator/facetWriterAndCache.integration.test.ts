/**
 * Integration tests for createFacetWriter + createFacetCacheReader
 * (Plan 4C Phase 2 Part 15).
 *
 * Verifies the concrete `insertFacet` and `getFacet` factories wired
 * against a real Postgres testcontainer + Drizzle. The writer is consumed
 * by `extractOne` (from `@caliber/evaluator`) to record facet rows; the
 * cache reader is consumed by `ensureFacets` to skip up-to-date
 * sessions.
 *
 * Confirms:
 *   - inserts a fresh facet row, cache reader reads it back
 *   - re-write at a new prompt_version updates row in place (ON CONFLICT path)
 *   - cascade-delete from request_bodies removes the facet row
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import {
  apiKeys,
  organizations,
  requestBodies,
  requestBodyFacets,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { createFacetWriter } from "../../../src/workers/evaluator/facetWriter.js";
import { createFacetCacheReader } from "../../../src/workers/evaluator/facetCache.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

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
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "facet-writer-test-org", name: "Facet Writer Test" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "facet-writer-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "facet-writer-upstream",
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
      keyHash: `hash-facet-writer-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "fw-test",
      name: "facet-writer-key",
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
  // CASCADE clears request_body_facets (FK on request_bodies)
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── FK-chain helper: usage_logs → request_bodies (so facet FK can be satisfied)

async function seedRequestBody(requestId: string): Promise<void> {
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

  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: Buffer.from("sealed-req"),
    responseBodySealed: Buffer.from("sealed-res"),
    stopReason: "end_turn",
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    retentionUntil: new Date("2099-01-01T00:00:00.000Z"),
  });
}

describe("createFacetWriter + createFacetCacheReader (integration)", () => {
  it("writes a facet row and reads back its promptVersion via the cache reader", async () => {
    const requestId = "req-facet-001";
    await seedRequestBody(requestId);

    const writer = createFacetWriter(db);
    const reader = createFacetCacheReader(db);

    expect(await reader(requestId)).toBeNull();

    await writer({
      requestId,
      orgId,
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 5,
      frictionCount: 1,
      bugsCaughtCount: 2,
      codexErrorsCount: 0,
      userSatisfaction: 4,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
      extractionError: null,
    });

    const cached = await reader(requestId);
    expect(cached).not.toBeNull();
    expect(cached!.promptVersion).toBe(1);

    const rows = await db
      .select()
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.sessionType).toBe("feature_dev");
    expect(row.outcome).toBe("success");
    expect(row.claudeHelpfulness).toBe(5);
    expect(row.frictionCount).toBe(1);
    expect(row.bugsCaughtCount).toBe(2);
    expect(row.codexErrorsCount).toBe(0);
    expect(row.userSatisfaction).toBe(4);
    expect(row.extractedWithModel).toBe("claude-haiku-4-5");
    expect(row.promptVersion).toBe(1);
    expect(row.extractionError).toBeNull();
  });

  it("re-writes the same request_id at a new prompt_version (ON CONFLICT path)", async () => {
    const requestId = "req-facet-002";
    await seedRequestBody(requestId);

    const writer = createFacetWriter(db);
    const reader = createFacetCacheReader(db);

    await writer({
      requestId,
      orgId,
      sessionType: "bug_fix",
      outcome: "failure",
      claudeHelpfulness: 2,
      frictionCount: 5,
      bugsCaughtCount: 0,
      codexErrorsCount: 3,
      userSatisfaction: 2,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
      extractionError: null,
    });

    expect((await reader(requestId))!.promptVersion).toBe(1);

    // Re-write at version 2 with different fields
    await writer({
      requestId,
      orgId,
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 5,
      frictionCount: 0,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
      userSatisfaction: 5,
      extractedWithModel: "claude-sonnet-4-6",
      promptVersion: 2,
      extractionError: null,
    });

    // Still exactly one row (upsert, not insert)
    const rows = await db
      .select()
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.promptVersion).toBe(2);
    expect(row.sessionType).toBe("feature_dev");
    expect(row.outcome).toBe("success");
    expect(row.claudeHelpfulness).toBe(5);
    expect(row.userSatisfaction).toBe(5);
    expect(row.extractedWithModel).toBe("claude-sonnet-4-6");

    expect((await reader(requestId))!.promptVersion).toBe(2);
  });

  it("writes a deterministic-error row (extractionError populated, fields null)", async () => {
    const requestId = "req-facet-err";
    await seedRequestBody(requestId);
    const writer = createFacetWriter(db);

    await writer({
      requestId,
      orgId,
      sessionType: null,
      outcome: null,
      claudeHelpfulness: null,
      frictionCount: null,
      bugsCaughtCount: null,
      codexErrorsCount: null,
      userSatisfaction: null,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
      extractionError: "parse_error: Invalid JSON: Unexpected token",
    });

    const rows = await db
      .select()
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.extractionError).toMatch(/^parse_error:/);
    expect(row.sessionType).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.claudeHelpfulness).toBeNull();
  });

  it("cascade-deletes the facet row when the parent request_body is removed", async () => {
    const requestId = "req-facet-cascade";
    await seedRequestBody(requestId);
    const writer = createFacetWriter(db);

    await writer({
      requestId,
      orgId,
      sessionType: "refactor",
      outcome: "partial",
      claudeHelpfulness: 3,
      frictionCount: 1,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
      userSatisfaction: 3,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
      extractionError: null,
    });

    const before = await db
      .select()
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId));
    expect(before).toHaveLength(1);

    // Delete the parent request_body — cascade should remove the facet row
    await db
      .delete(requestBodies)
      .where(eq(requestBodies.requestId, requestId));

    const after = await db
      .select()
      .from(requestBodyFacets)
      .where(eq(requestBodyFacets.requestId, requestId));
    expect(after).toHaveLength(0);
  });
});
