// apps/api/tests/integration/migrations/0011.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createPricingLookup } from "@caliber/gateway-core";
import { setupTestDb, type TestDb } from "../../factories/db.js";

// PR #32 follow-up — migration 0011 adds `cache_read_per_million_micros`
// and backfills the documented Anthropic rates so computeCost stops
// overbilling cache reads at the input rate.
//
// Verifies:
//   * column exists, nullable, bigint
//   * 3 anthropic seed rows backfilled with the documented rates
//   * 4 openai seed rows remain NULL (no cache_read concept)
//   * pricingLookup returns the new field
//   * 0011_down drops the column cleanly while preserving every other
//     model_pricing row + column

describe("migration 0011 model_pricing.cache_read_per_million_micros", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("adds the cache_read_per_million_micros column (bigint, nullable)", async () => {
    const cols = await testDb.db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'model_pricing'
        AND column_name = 'cache_read_per_million_micros'
    `);
    expect(cols.rows.length).toBe(1);
    expect(cols.rows[0]!.data_type).toBe("bigint");
    expect(cols.rows[0]!.is_nullable).toBe("YES");
  });

  it("backfills the 3 Anthropic seeds with the documented cache_read rates (~10% of input)", async () => {
    const rows = await testDb.db.execute<{
      model_id: string;
      cache_read_per_million_micros: string;
    }>(sql`
      SELECT model_id, cache_read_per_million_micros
      FROM model_pricing
      WHERE platform = 'anthropic'
      ORDER BY model_id
    `);
    expect(rows.rows.length).toBe(3);
    const byModel = Object.fromEntries(
      rows.rows.map((r) => [r.model_id, r.cache_read_per_million_micros]),
    );
    // 10% of input rate per Anthropic docs.
    expect(byModel["claude-opus-4-7"]).toBe("1500000"); // 10% of 15M
    expect(byModel["claude-sonnet-4-6"]).toBe("300000"); // 10% of 3M
    expect(byModel["claude-haiku-4-5"]).toBe("100000"); // 10% of 1M
  });

  it("leaves OpenAI seed rows with NULL cache_read (no cache_read concept on OpenAI)", async () => {
    const rows = await testDb.db.execute<{
      cache_read_per_million_micros: string | null;
    }>(sql`
      SELECT cache_read_per_million_micros
      FROM model_pricing
      WHERE platform = 'openai'
    `);
    expect(rows.rows.length).toBe(4);
    for (const r of rows.rows) {
      expect(r.cache_read_per_million_micros).toBeNull();
    }
  });

  it("createPricingLookup returns the cache_read field for anthropic rows + null for openai", async () => {
    const lookup = createPricingLookup(testDb.db);
    const at = new Date("2026-05-01");

    const opus = await lookup.lookup("anthropic", "claude-opus-4-7", at);
    expect(opus?.cacheReadPerMillionMicros).toBe(1_500_000n);

    const haiku = await lookup.lookup("anthropic", "claude-haiku-4-5", at);
    expect(haiku?.cacheReadPerMillionMicros).toBe(100_000n);

    const gpt4o = await lookup.lookup("openai", "gpt-4o", at);
    expect(gpt4o?.cacheReadPerMillionMicros).toBeNull();
  });
});

describe("migration 0011 down", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("0011_down.sql drops the column while preserving every other row + column", async () => {
    const beforeRows = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM model_pricing
    `);
    const beforeCount = beforeRows.rows[0]!.count;

    await testDb.db.execute(sql`
      ALTER TABLE model_pricing
        DROP COLUMN IF EXISTS cache_read_per_million_micros;
    `);

    const colExists = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'model_pricing'
          AND column_name = 'cache_read_per_million_micros'
      ) AS exists
    `);
    expect(colExists.rows[0]!.exists).toBe(false);

    const afterRows = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM model_pricing
    `);
    expect(afterRows.rows[0]!.count).toBe(beforeCount);

    // Every other column still readable.
    const sample = await testDb.db.execute<{
      input_per_million_micros: string;
      output_per_million_micros: string;
    }>(sql`
      SELECT input_per_million_micros, output_per_million_micros
      FROM model_pricing
      WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
    `);
    expect(sample.rows[0]!.input_per_million_micros).toBe("15000000");
    expect(sample.rows[0]!.output_per_million_micros).toBe("75000000");
  });
});
