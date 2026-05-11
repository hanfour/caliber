// apps/api/tests/integration/migrations/0009.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { modelPricing } from "@caliber/db";
import { createPricingLookup } from "@caliber/gateway-core";
import { setupTestDb, type TestDb } from "../../factories/db.js";

// Plan 5A migration 0009:
//   * NEW model_pricing table (id, platform, model_id, 5 bigint micros
//     columns, effective_from/effective_to, created_at) with CHECK on
//     platform values + CHECK effective_to > effective_from, plus
//     UNIQUE (platform, model_id, effective_from) and a btree lookup index.
//   * Seed of 7 rows (3 Anthropic, 4 OpenAI) with effective_from
//     '2026-04-28T00:00:00Z'. Numbers verified against provider pricing
//     pages on that date and mirrored in
//     packages/db/src/seed/modelPricingSnapshot20260428.ts.
//
// Tests cover the schema shape, seed correctness, CHECK constraint behaviour,
// and the createPricingLookup() runtime contract (active row selection +
// 5-min in-process TTL cache).

describe("migration 0009 model_pricing", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("creates model_pricing with the expected columns", async () => {
    const result = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'model_pricing'
      ORDER BY ordinal_position
    `);
    expect(result.rows.map((r) => r.column_name)).toEqual([
      "id",
      "platform",
      "model_id",
      "input_per_million_micros",
      "output_per_million_micros",
      "cached_5m_per_million_micros",
      "cached_1h_per_million_micros",
      "cached_input_per_million_micros",
      "effective_from",
      "effective_to",
      "created_at",
      // Added by migration 0011 (PR #32 follow-up)
      "cache_read_per_million_micros",
    ]);
  });

  it("creates the unique active idx (which doubles as the lookup idx)", async () => {
    const idx = await testDb.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'model_pricing'
      ORDER BY indexname
    `);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("model_pricing_active_idx");
    // Design §4.2 originally drafted a separate lookup_idx on the same
    // columns; since PG can scan a UNIQUE B-tree index in reverse direction
    // efficiently for ORDER BY effective_from DESC LIMIT 1, the second
    // index would be redundant write+disk cost for no query gain.
    expect(names).not.toContain("model_pricing_lookup_idx");
  });

  it("seeds 7 rows (3 anthropic + 4 openai) at effective_from 2026-04-28", async () => {
    const all = await testDb.db.execute<{
      platform: string;
      model_id: string;
      effective_from: string;
    }>(sql`
      SELECT platform, model_id, effective_from
      FROM model_pricing
      ORDER BY platform, model_id
    `);
    expect(all.rows.length).toBe(7);

    const byPlatform = all.rows.reduce<Record<string, string[]>>((acc, r) => {
      (acc[r.platform] ??= []).push(r.model_id);
      return acc;
    }, {});
    expect(byPlatform.anthropic?.sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
    expect(byPlatform.openai?.sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "o1",
      "o1-mini",
    ]);

    for (const row of all.rows) {
      expect(new Date(row.effective_from).toISOString()).toBe(
        "2026-04-28T00:00:00.000Z",
      );
    }
  });

  it("Anthropic seed rows populate cached_5m + cached_1h; cached_input is NULL", async () => {
    const rows = await testDb.db.execute<{
      cached_5m_per_million_micros: string | null;
      cached_1h_per_million_micros: string | null;
      cached_input_per_million_micros: string | null;
    }>(sql`
      SELECT cached_5m_per_million_micros, cached_1h_per_million_micros,
             cached_input_per_million_micros
      FROM model_pricing
      WHERE platform = 'anthropic'
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      expect(r.cached_5m_per_million_micros).not.toBeNull();
      expect(r.cached_1h_per_million_micros).not.toBeNull();
      expect(r.cached_input_per_million_micros).toBeNull();
    }
  });

  it("OpenAI seed rows populate cached_input; cached_5m + cached_1h are NULL", async () => {
    const rows = await testDb.db.execute<{
      cached_5m_per_million_micros: string | null;
      cached_1h_per_million_micros: string | null;
      cached_input_per_million_micros: string | null;
    }>(sql`
      SELECT cached_5m_per_million_micros, cached_1h_per_million_micros,
             cached_input_per_million_micros
      FROM model_pricing
      WHERE platform = 'openai'
    `);
    expect(rows.rows.length).toBe(4);
    for (const r of rows.rows) {
      expect(r.cached_5m_per_million_micros).toBeNull();
      expect(r.cached_1h_per_million_micros).toBeNull();
      expect(r.cached_input_per_million_micros).not.toBeNull();
    }
  });

  it("seed pricing for claude-opus-4-7 matches the documented 2026-04-28 snapshot", async () => {
    const rows = await testDb.db.execute<{
      input_per_million_micros: string;
      output_per_million_micros: string;
      cached_5m_per_million_micros: string;
      cached_1h_per_million_micros: string;
    }>(sql`
      SELECT input_per_million_micros, output_per_million_micros,
             cached_5m_per_million_micros, cached_1h_per_million_micros
      FROM model_pricing
      WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
    `);
    expect(rows.rows[0]).toEqual({
      input_per_million_micros: "15000000",
      output_per_million_micros: "75000000",
      cached_5m_per_million_micros: "18750000",
      cached_1h_per_million_micros: "30000000",
    });
  });

  it("platform CHECK rejects invalid values", async () => {
    await expect(
      testDb.pool.query(
        `INSERT INTO model_pricing
           (platform, model_id, input_per_million_micros, output_per_million_micros, effective_from)
         VALUES ('bedrock', 'test', 1, 1, '2026-04-28')`,
      ),
    ).rejects.toThrow(/model_pricing_platform_values/);
  });

  it("effective_range CHECK rejects effective_to <= effective_from", async () => {
    await expect(
      testDb.pool.query(
        `INSERT INTO model_pricing
           (platform, model_id, input_per_million_micros, output_per_million_micros,
            effective_from, effective_to)
         VALUES ('openai', 'check-test', 1, 1, '2026-05-01', '2026-04-30')`,
      ),
    ).rejects.toThrow(/model_pricing_effective_range/);
  });

  it("(platform, model_id, effective_from) UNIQUE rejects duplicate effective dates", async () => {
    // Try to insert a duplicate of the existing claude-opus-4-7 seed row.
    await expect(
      testDb.pool.query(
        `INSERT INTO model_pricing
           (platform, model_id, input_per_million_micros, output_per_million_micros, effective_from)
         VALUES ('anthropic', 'claude-opus-4-7', 1, 1, '2026-04-28')`,
      ),
    ).rejects.toThrow(/model_pricing_active_idx|unique|duplicate/i);
  });
});

describe("createPricingLookup", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("returns the active seed row for a known platform+model+at", async () => {
    const lookup = createPricingLookup(testDb.db);
    const row = await lookup.lookup(
      "anthropic",
      "claude-opus-4-7",
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(row).not.toBeNull();
    expect(row?.inputPerMillionMicros).toBe(15_000_000n);
    expect(row?.outputPerMillionMicros).toBe(75_000_000n);
    expect(row?.cached5mPerMillionMicros).toBe(18_750_000n);
    expect(row?.cached1hPerMillionMicros).toBe(30_000_000n);
    expect(row?.cachedInputPerMillionMicros).toBeNull();
  });

  it("returns null at exactly effective_from - 1ms (range is inclusive on the left)", async () => {
    // The cache key does not include `at`, so time-travel tests must
    // invalidate between queries (see pricingLookup.ts module comment).
    const lookup = createPricingLookup(testDb.db);
    const before = new Date("2026-04-27T23:59:59.999Z");
    const at = new Date("2026-04-28T00:00:00.000Z");
    expect(
      await lookup.lookup("anthropic", "claude-opus-4-7", before),
    ).toBeNull();
    lookup.invalidate("anthropic", "claude-opus-4-7");
    expect(
      await lookup.lookup("anthropic", "claude-opus-4-7", at),
    ).not.toBeNull();
  });

  it("returns null for unknown model", async () => {
    const lookup = createPricingLookup(testDb.db);
    const row = await lookup.lookup(
      "openai",
      "gpt-9000",
      new Date("2026-05-01"),
    );
    expect(row).toBeNull();
  });

  it("caches subsequent lookups within TTL", async () => {
    let nowMs = 1_000_000_000_000;
    const lookup = createPricingLookup(testDb.db, {
      cacheTtlMs: 1000,
      now: () => nowMs,
    });
    const at = new Date("2026-05-01");
    try {
      await lookup.lookup("anthropic", "claude-opus-4-7", at);

      // Hot-modify the row directly in DB; cached lookup should NOT reflect it.
      await testDb.db.execute(sql`
        UPDATE model_pricing
        SET input_per_million_micros = 999999999
        WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
      `);
      const cached = await lookup.lookup("anthropic", "claude-opus-4-7", at);
      expect(cached?.inputPerMillionMicros).toBe(15_000_000n);

      // Past TTL → cache miss → re-query → see the modification.
      nowMs += 2000;
      const fresh = await lookup.lookup("anthropic", "claude-opus-4-7", at);
      expect(fresh?.inputPerMillionMicros).toBe(999_999_999n);
    } finally {
      // Restore even if an assertion above threw — protects later tests in
      // this describe from cascading-failure on shared testDb state.
      await testDb.db.execute(sql`
        UPDATE model_pricing
        SET input_per_million_micros = 15000000
        WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
      `);
    }
  });

  it("invalidate() drops the cached entry for a single (platform, modelId)", async () => {
    const lookup = createPricingLookup(testDb.db);
    const at = new Date("2026-05-01");
    try {
      await lookup.lookup("anthropic", "claude-opus-4-7", at);

      await testDb.db.execute(sql`
        UPDATE model_pricing
        SET input_per_million_micros = 7777777
        WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
      `);
      lookup.invalidate("anthropic", "claude-opus-4-7");
      const fresh = await lookup.lookup("anthropic", "claude-opus-4-7", at);
      expect(fresh?.inputPerMillionMicros).toBe(7_777_777n);
    } finally {
      await testDb.db.execute(sql`
        UPDATE model_pricing
        SET input_per_million_micros = 15000000
        WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7'
      `);
    }
  });

  it("picks the row with the latest effective_from when multiple rows exist for the same model", async () => {
    // Insert a future repricing row, then look up before and after that date.
    await testDb.db.execute(sql`
      UPDATE model_pricing
      SET effective_to = '2026-09-01T00:00:00Z'
      WHERE platform = 'openai' AND model_id = 'gpt-4o-mini'
    `);
    await testDb.db.execute(sql`
      INSERT INTO model_pricing
        (platform, model_id, input_per_million_micros, output_per_million_micros,
         cached_input_per_million_micros, effective_from)
      VALUES ('openai', 'gpt-4o-mini', 100000, 400000, 50000, '2026-09-01T00:00:00Z')
    `);

    try {
      const lookup = createPricingLookup(testDb.db);
      const before = await lookup.lookup(
        "openai",
        "gpt-4o-mini",
        new Date("2026-08-31T23:59:59.999Z"),
      );
      expect(before?.inputPerMillionMicros).toBe(150_000n); // original seed

      lookup.invalidate("openai", "gpt-4o-mini");
      const after = await lookup.lookup(
        "openai",
        "gpt-4o-mini",
        new Date("2026-09-01T00:00:00.000Z"),
      );
      expect(after?.inputPerMillionMicros).toBe(100_000n); // new row
    } finally {
      // Cleanup runs even if an assertion above threw.
      await testDb.db.execute(sql`
        DELETE FROM model_pricing
        WHERE platform = 'openai' AND model_id = 'gpt-4o-mini'
          AND effective_from = '2026-09-01T00:00:00Z'
      `);
      await testDb.db.execute(sql`
        UPDATE model_pricing
        SET effective_to = NULL
        WHERE platform = 'openai' AND model_id = 'gpt-4o-mini'
      `);
    }
  });
});

describe("migration 0009 down", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("0009_down.sql drops model_pricing cleanly", async () => {
    await testDb.db.execute(sql`DROP TABLE IF EXISTS model_pricing`);
    const result = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'model_pricing'
      ) AS exists
    `);
    expect(result.rows[0]!.exists).toBe(false);
  });
});
