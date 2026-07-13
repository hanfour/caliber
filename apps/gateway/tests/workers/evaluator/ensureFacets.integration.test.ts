/**
 * End-to-end integration test for ensureFacets + extractOne wired against
 * a real Postgres + the gateway's concrete facet writer/cache reader
 * (Plan 4C Phase 2 Part 15).
 *
 * The LLM call is mocked at the `callWithCostTracking` boundary so we
 * exercise the full stack: cache read → extractOne → parse → facet write.
 *
 * Confirms the layered design works end-to-end and de-risks the eventual
 * runEvaluation.ts integration:
 *   - First pass: 3 sessions seeded, no facets in DB → 3 extracted, 0 cache hits
 *   - Second pass: same 3 sessions → 0 extracted, 3 cache hits
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
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
import {
  ensureFacets,
  extractOne,
  type FacetCallDeps,
  type FacetSession,
} from "@caliber/evaluator";
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
    .values({ slug: "ensure-facets-test-org", name: "Ensure Facets Test" })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "ensure-facets-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "ensure-facets-upstream",
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
      keyHash: `hash-ensure-facets-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "ef-test",
      name: "ensure-facets-key",
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
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

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

function makeSession(requestId: string): FacetSession {
  return {
    requestId,
    orgId,
    turns: [
      { role: "user", content: `please help with task ${requestId}` },
      { role: "assistant", content: "done!" },
    ],
  };
}

const CANNED_FACET_TEXT = JSON.stringify({
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 0,
  bugsCaughtCount: 1,
  codexErrorsCount: 0,
  userSatisfaction: 4,
});

describe("ensureFacets — end-to-end (real DB + mocked LLM)", () => {
  it("extracts all sessions on first pass, then 100% cache hits on second pass", async () => {
    const requestIds = ["req-e2e-1", "req-e2e-2", "req-e2e-3"];
    for (const id of requestIds) {
      await seedRequestBody(id);
    }
    const sessions = requestIds.map(makeSession);

    // Mock the LLM-+-budget wrapper. extractOne calls this exactly once per session.
    const callWithCostTracking = vi.fn().mockResolvedValue({
      response: {
        text: CANNED_FACET_TEXT,
        usage: { input_tokens: 200, output_tokens: 50 },
      },
      cost: 0.0001,
    });

    const insertFacet = createFacetWriter(db);
    const getFacet = createFacetCacheReader(db);

    const facetDeps: FacetCallDeps = {
      callWithCostTracking:
        callWithCostTracking as unknown as FacetCallDeps["callWithCostTracking"],
      insertFacet,
      facetModel: "claude-haiku-4-5",
    };

    // ── First pass: nothing in DB → all 3 should extract
    const first = await ensureFacets(sessions, {
      getFacet,
      extractOne: (s) => extractOne(s, facetDeps),
      concurrency: 5,
    });

    expect(first).toEqual({ extracted: 3, cacheHits: 0 });
    expect(callWithCostTracking).toHaveBeenCalledTimes(3);

    const rowsAfterFirst = await db.select().from(requestBodyFacets);
    expect(rowsAfterFirst).toHaveLength(3);
    for (const row of rowsAfterFirst) {
      expect(row.sessionType).toBe("feature_dev");
      expect(row.outcome).toBe("success");
      expect(row.claudeHelpfulness).toBe(4);
      expect(row.userSatisfaction).toBe(4);
      expect(row.extractedWithModel).toBe("claude-haiku-4-5");
      expect(row.promptVersion).toBe(2);
      expect(row.extractionError).toBeNull();
    }

    // ── Second pass: all 3 are at the current prompt_version → 100% cache hits
    callWithCostTracking.mockClear();
    const second = await ensureFacets(sessions, {
      getFacet,
      extractOne: (s) => extractOne(s, facetDeps),
      concurrency: 5,
    });

    expect(second).toEqual({ extracted: 0, cacheHits: 3 });
    expect(callWithCostTracking).not.toHaveBeenCalled();

    // Still exactly 3 rows
    const rowsAfterSecond = await db.select().from(requestBodyFacets);
    expect(rowsAfterSecond).toHaveLength(3);
  });

  it("writes a deterministic-error row when the LLM returns unparseable text, returns extracted=1", async () => {
    const requestId = "req-e2e-bad";
    await seedRequestBody(requestId);
    const sessions = [makeSession(requestId)];

    const callWithCostTracking = vi.fn().mockResolvedValue({
      response: {
        text: "I cannot complete that JSON request",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      cost: 0.00005,
    });

    const insertFacet = createFacetWriter(db);
    const getFacet = createFacetCacheReader(db);
    const facetDeps: FacetCallDeps = {
      callWithCostTracking:
        callWithCostTracking as unknown as FacetCallDeps["callWithCostTracking"],
      insertFacet,
      facetModel: "claude-haiku-4-5",
    };

    const result = await ensureFacets(sessions, {
      getFacet,
      extractOne: (s) => extractOne(s, facetDeps),
      concurrency: 1,
    });

    expect(result).toEqual({ extracted: 1, cacheHits: 0 });

    const rows = await db.select().from(requestBodyFacets);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.extractionError).toMatch(/^parse_error:/);
    expect(row.sessionType).toBeNull();
    expect(row.promptVersion).toBe(2);
  });
});
