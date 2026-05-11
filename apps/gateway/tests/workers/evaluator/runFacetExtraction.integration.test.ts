/**
 * Integration test for runFacetExtraction (Plan 4C follow-up #1).
 *
 * Wires the full stack — Drizzle/Postgres + ioredis-mock + injected fetch —
 * but mocks the loopback /v1/messages call. Confirms:
 *   1. Flag off → skipped, no rows.
 *   2. Org facet disabled → skipped, no rows.
 *   3. Happy path → 2 facet rows + 2 ledger rows.
 *   4. Cache hit → second pass writes nothing, reports cache hits.
 *   5. LLM 500 → no facet rows, fail-soft (no throw).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
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
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  apiKeys,
  llmUsageEvents,
  organizations,
  requestBodies,
  requestBodyFacets,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import type { BodyRow } from "@caliber/evaluator";
import { runFacetExtraction } from "../../../src/workers/evaluator/runFacetExtraction.js";
import { LLM_KEY_REDIS_PREFIX } from "../../../src/workers/evaluator/runLlm.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const STUB_FACET_MODEL = "claude-haiku-4-5";
const STUB_RAW_KEY = "caliber-eval-deadbeefdeadbeefdeadbeefdeadbeef";

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

const redis = new RedisMock() as unknown as Redis;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "run-facet-extraction-test",
      name: "Run Facet Extraction Test",
      llmFacetEnabled: true,
      llmFacetModel: STUB_FACET_MODEL,
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "run-facet-extraction-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "facet-test-upstream",
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
      keyHash: `hash-facet-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "facet-test",
      name: "facet-test-key",
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
  await db.execute(
    sql`TRUNCATE TABLE request_body_facets RESTART IDENTITY CASCADE`,
  );
  await db.execute(
    sql`TRUNCATE TABLE llm_usage_events RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`TRUNCATE TABLE request_bodies RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  // Reset org back to enabled (some tests mutate it)
  await db
    .update(organizations)
    .set({ llmFacetEnabled: true, llmFacetModel: STUB_FACET_MODEL })
    .where(eq(organizations.id, orgId));

  await redis.flushall();
  await redis.set(`${LLM_KEY_REDIS_PREFIX}${orgId}`, STUB_RAW_KEY);
});

afterEach(() => {
  delete process.env.ENABLE_FACET_EXTRACTION;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const CANNED_FACET_JSON = JSON.stringify({
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 0,
  bugsCaughtCount: 1,
  codexErrorsCount: 0,
});

function makeBody(requestId: string): BodyRow {
  return {
    requestId,
    stopReason: "end_turn",
    clientUserAgent: null,
    clientSessionId: null,
    requestParams: null,
    requestBody: {
      messages: [{ role: "user", content: `task ${requestId}` }],
    },
    responseBody: { content: [{ type: "text", text: "done" }] },
  };
}

/**
 * Seed the usage_logs + request_bodies rows that satisfy the FK chain
 * needed before request_body_facets can be inserted.
 */
async function seedFkChain(requestId: string): Promise<void> {
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
    clientUserAgent: null,
    clientSessionId: null,
    retentionUntil: new Date("2099-01-01T00:00:00.000Z"),
  });
}

function makeFetchOk(): typeof fetch {
  return vi.fn(async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": `mock-${Math.random().toString(36).slice(2)}`,
    });
    return new Response(
      JSON.stringify({
        id: "msg-mock",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: CANNED_FACET_JSON }],
        model: STUB_FACET_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 50 },
      }),
      { status: 200, headers },
    );
  }) as unknown as typeof fetch;
}

function makeFetch500(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "upstream" }), {
        status: 500,
        headers: new Headers({ "content-type": "application/json" }),
      }),
  ) as unknown as typeof fetch;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runFacetExtraction — integration", () => {
  it("1. returns flag_off and writes nothing when ENABLE_FACET_EXTRACTION is unset", async () => {
    // Flag intentionally NOT set
    const result = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies: [makeBody("aaaaaaaa-1111-1111-1111-000000000001")],
      fetchImpl: makeFetchOk(),
    });

    expect(result).toEqual({
      attempted: 0,
      extracted: 0,
      cacheHits: 0,
      skippedReason: "flag_off",
    });

    const facets = await db.select().from(requestBodyFacets);
    expect(facets).toHaveLength(0);
    const ledgers = await db.select().from(llmUsageEvents);
    expect(ledgers).toHaveLength(0);
  });

  it("2. returns facet_disabled when org has llm_facet_enabled=false", async () => {
    process.env.ENABLE_FACET_EXTRACTION = "true";
    await db
      .update(organizations)
      .set({ llmFacetEnabled: false })
      .where(eq(organizations.id, orgId));

    const result = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies: [makeBody("aaaaaaaa-2222-2222-2222-000000000001")],
      fetchImpl: makeFetchOk(),
    });

    expect(result.skippedReason).toBe("facet_disabled");
    expect(result.extracted).toBe(0);

    const facets = await db.select().from(requestBodyFacets);
    expect(facets).toHaveLength(0);
  });

  it("3. happy path → 2 bodies write 2 facet rows + 2 ledger rows", async () => {
    process.env.ENABLE_FACET_EXTRACTION = "true";
    const id1 = "aaaaaaaa-3333-3333-3333-000000000001";
    const id2 = "aaaaaaaa-3333-3333-3333-000000000002";
    await seedFkChain(id1);
    await seedFkChain(id2);

    const bodies = [makeBody(id1), makeBody(id2)];
    const fetchImpl = makeFetchOk();

    const result = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies,
      fetchImpl,
    });

    expect(result).toEqual({
      attempted: 2,
      extracted: 2,
      cacheHits: 0,
    });

    const facets = await db
      .select()
      .from(requestBodyFacets)
      .orderBy(requestBodyFacets.requestId);
    expect(facets).toHaveLength(2);
    for (const row of facets) {
      expect(row.extractionError).toBeNull();
      expect(row.sessionType).toBe("feature_dev");
      expect(row.outcome).toBe("success");
      expect(row.claudeHelpfulness).toBe(4);
      expect(row.extractedWithModel).toBe(STUB_FACET_MODEL);
      expect(row.promptVersion).toBe(1);
    }

    const ledgers = await db.select().from(llmUsageEvents);
    expect(ledgers).toHaveLength(2);
    for (const row of ledgers) {
      expect(row.eventType).toBe("facet_extraction");
      expect(row.model).toBe(STUB_FACET_MODEL);
      expect(row.refType).toBe("request_body_facet");
      expect(Number(row.costUsd)).toBeGreaterThan(0);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("4. second pass with same bodies → 0 extracted, 2 cache hits", async () => {
    process.env.ENABLE_FACET_EXTRACTION = "true";
    const id1 = "aaaaaaaa-4444-4444-4444-000000000001";
    const id2 = "aaaaaaaa-4444-4444-4444-000000000002";
    await seedFkChain(id1);
    await seedFkChain(id2);

    const bodies = [makeBody(id1), makeBody(id2)];

    // First pass: populate
    const first = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies,
      fetchImpl: makeFetchOk(),
    });
    expect(first.extracted).toBe(2);

    // Second pass: should hit cache for both
    const fetch2 = makeFetchOk();
    const second = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies,
      fetchImpl: fetch2,
    });

    expect(second).toEqual({
      attempted: 2,
      extracted: 0,
      cacheHits: 2,
    });
    expect(fetch2).not.toHaveBeenCalled();

    // Still exactly 2 facet rows
    const facets = await db.select().from(requestBodyFacets);
    expect(facets).toHaveLength(2);
  });

  it("5. LLM returns 500 → no facet rows, fail-soft (no throw)", async () => {
    process.env.ENABLE_FACET_EXTRACTION = "true";

    const bodies = [makeBody("aaaaaaaa-5555-5555-5555-000000000001")];
    const fetchImpl = makeFetch500();

    const result = await runFacetExtraction({
      db,
      redis,
      gatewayBaseUrl: "http://localhost:3002",
      orgId,
      bodies,
      fetchImpl,
    });

    // Transient (5xx) → extractor skips writing a row; ensureFacets still
    // counts the session as "attempted to extract" via `extracted`.
    expect(result.attempted).toBe(1);
    expect(result.extracted).toBe(1);
    expect(result.cacheHits).toBe(0);
    expect(result.skippedReason).toBeUndefined();

    // But no row was actually written (transient errors skip the row entirely)
    const facets = await db.select().from(requestBodyFacets);
    expect(facets).toHaveLength(0);

    // Ledger also untouched (call failed before usage was returned)
    const ledgers = await db.select().from(llmUsageEvents);
    expect(ledgers).toHaveLength(0);
  });
});
