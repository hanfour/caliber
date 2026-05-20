// apps/api/tests/integration/migrations/0005.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  apiKeys,
  requestBodies,
  requestBodyFacets,
  upstreamAccounts,
  usageLogs,
} from "@caliber/db";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg } from "../../factories/org.js";
import { makeUser } from "../../factories/user.js";

// ── Seed helpers ─────────────────────────────────────────────────────────────
// request_body_facets → request_bodies → usage_logs → api_keys + upstream_accounts
// We satisfy the FK chain with the minimum non-null columns.

let seedCounter = 0;
function uniqId(prefix: string): string {
  seedCounter += 1;
  return `${prefix}-${Date.now()}-${seedCounter}`;
}

async function seedFkChain(
  db: Database,
  opts: { orgId: string; userId: string; requestId: string },
): Promise<void> {
  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      teamId: null,
      keyHash: `hash-${uniqId("k")}`,
      keyPrefix: "ak_t",
      name: `migr5-key-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });

  const [account] = await db
    .insert(upstreamAccounts)
    .values({
      orgId: opts.orgId,
      name: `migr5-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });

  await db.insert(usageLogs).values({
    requestId: opts.requestId,
    userId: opts.userId,
    apiKeyId: apiKey!.id,
    accountId: account!.id,
    orgId: opts.orgId,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0001",
    outputCost: "0.0002",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: "0.0003",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    stream: false,
    statusCode: 200,
    durationMs: 100,
    upstreamRetries: 0,
  });

  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await db.insert(requestBodies).values({
    requestId: opts.requestId,
    orgId: opts.orgId,
    requestBodySealed: Buffer.from("test-request"),
    responseBodySealed: Buffer.from("test-response"),
    retentionUntil: futureDate,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("migration 0005 request_body_facets", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("creates request_body_facets with expected columns", async () => {
    // arrayContaining (not strict equality) so future migrations that extend
    // request_body_facets — e.g. 0014's transcript-only facet columns — don't
    // regress this 0005-scoped check. The contract here is "0005 introduced
    // exactly these columns"; later migrations adding more is orthogonal.
    const result = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'request_body_facets'
      ORDER BY ordinal_position
    `);
    expect(result.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining([
        "id",
        "request_id",
        "org_id",
        "session_type",
        "outcome",
        "claude_helpfulness",
        "friction_count",
        "bugs_caught_count",
        "codex_errors_count",
        "extracted_at",
        "extracted_with_model",
        "prompt_version",
        "extraction_error",
      ]),
    );
  });

  it("has expected indexes and unique constraint on request_id", async () => {
    const idx = await testDb.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'request_body_facets'
      ORDER BY indexname
    `);
    const names = idx.rows.map((r) => r.indexname).sort();
    expect(names).toContain("request_body_facets_org_extracted_idx");
    expect(names).toContain("request_body_facets_prompt_version_idx");
    expect(names).toContain("request_body_facets_request_id_unique");
  });

  it("enforces UNIQUE on request_id", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const requestId = uniqId("req-uniq");
    await seedFkChain(testDb.db, {
      orgId: org.id,
      userId: user.id,
      requestId,
    });

    await testDb.db.insert(requestBodyFacets).values({
      requestId,
      orgId: org.id,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
    });

    await expect(
      testDb.db.insert(requestBodyFacets).values({
        requestId,
        orgId: org.id,
        extractedWithModel: "claude-haiku-4-5",
        promptVersion: 1,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("cascades delete from request_bodies", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const requestId = uniqId("req-cascade");
    await seedFkChain(testDb.db, {
      orgId: org.id,
      userId: user.id,
      requestId,
    });

    await testDb.db.insert(requestBodyFacets).values({
      requestId,
      orgId: org.id,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
    });

    await testDb.db.execute(
      sql`DELETE FROM request_bodies WHERE request_id = ${requestId}`,
    );

    const after = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM request_body_facets
      WHERE request_id = ${requestId}
    `);
    expect(after.rows[0]!.count).toBe("0");
  });

  it("allows null facet fields when extraction failed", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const requestId = uniqId("req-err");
    await seedFkChain(testDb.db, {
      orgId: org.id,
      userId: user.id,
      requestId,
    });

    await testDb.db.insert(requestBodyFacets).values({
      requestId,
      orgId: org.id,
      extractedWithModel: "claude-haiku-4-5",
      promptVersion: 1,
      extractionError: "parse_error: bad json",
    });

    const r = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM request_body_facets
      WHERE request_id = ${requestId}
        AND extraction_error IS NOT NULL
        AND session_type IS NULL
        AND outcome IS NULL
        AND claude_helpfulness IS NULL
    `);
    expect(r.rows[0]!.count).toBe("1");
  });
});
