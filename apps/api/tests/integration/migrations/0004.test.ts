// apps/api/tests/integration/migrations/0004.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg } from "../../factories/org.js";

describe("migration 0004 cost infra", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb(); // applies all migrations up to HEAD
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("adds 5 cost columns to organizations", async () => {
    const result = await testDb.db.execute<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'organizations'
        AND column_name IN (
          'llm_facet_enabled', 'llm_facet_model', 'llm_monthly_budget_usd',
          'llm_budget_overage_behavior', 'llm_halted_until_month_end'
        )
      ORDER BY column_name
    `);
    expect(result.rows).toHaveLength(5);
    const byName = Object.fromEntries(
      result.rows.map((r) => [r.column_name, r]),
    );
    expect(byName.llm_facet_enabled!.is_nullable).toBe("NO");
    expect(byName.llm_facet_enabled!.column_default).toBe("false");
    expect(byName.llm_facet_model!.is_nullable).toBe("YES");
    expect(byName.llm_monthly_budget_usd!.is_nullable).toBe("YES");
    expect(byName.llm_budget_overage_behavior!.is_nullable).toBe("NO");
    expect(byName.llm_budget_overage_behavior!.column_default).toContain(
      "degrade",
    );
    expect(byName.llm_halted_until_month_end!.is_nullable).toBe("NO");
    expect(byName.llm_halted_until_month_end!.column_default).toBe("false");
  });

  it("creates llm_usage_events table with expected columns", async () => {
    const result = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'llm_usage_events'
      ORDER BY ordinal_position
    `);
    expect(result.rows.map((r) => r.column_name)).toEqual([
      "id",
      "org_id",
      "event_type",
      "model",
      "tokens_input",
      "tokens_output",
      "cost_usd",
      "ref_type",
      "ref_id",
      "created_at",
      "usage_log_request_id", // added by migration 0033
    ]);
  });

  it("can insert and query llm_usage_events rows", async () => {
    const org = await makeOrg(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES (${org.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 50, 0.0002)
    `);
    const result = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM llm_usage_events WHERE org_id = ${org.id}
    `);
    expect(result.rows[0]!.count).toBe("1");
  });

  it("cascades delete from organizations to llm_usage_events", async () => {
    const org = await makeOrg(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES (${org.id}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 0.001)
    `);

    await testDb.db.execute(
      sql`DELETE FROM organizations WHERE id = ${org.id}`,
    );

    const result = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM llm_usage_events WHERE org_id = ${org.id}
    `);
    expect(result.rows[0]!.count).toBe("0");
  });
});
