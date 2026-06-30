// apps/api/tests/integration/migrations/0022.test.ts
//
// Covers the per-project scoring DB layer additions:
//   - api_keys.evaluate_as_project column (NOT NULL, default false)
//   - evaluation_reports_by_key table (all scoring columns, api_key_id, key_name_snapshot,
//     4-tuple unique index, secondary indexes)
//   - llm_usage_events dedup partial unique index (llm_usage_dedup_idx)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/index.js";

describe("migration 0021/0022 — per-project scoring DB layer", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("api_keys.evaluate_as_project defaults false and is NOT NULL", async () => {
    const r = await testDb.db.execute(
      sql`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name='api_keys' AND column_name='evaluate_as_project'`,
    );
    expect(r.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(String(r.rows[0]!.column_default)).toMatch(/false/);
  });

  it("evaluation_reports_by_key has NOT NULL api_key_id + key_name_snapshot", async () => {
    const cols = await testDb.db.execute(
      sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='evaluation_reports_by_key' AND column_name IN ('api_key_id','key_name_snapshot')`,
    );
    expect(cols.rows).toHaveLength(2);
    for (const c of cols.rows) expect(c.is_nullable).toBe("NO");
  });

  it("evaluation_reports_by_key has the 4-tuple unique index", async () => {
    const uniq = await testDb.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename='evaluation_reports_by_key' AND indexdef ILIKE '%UNIQUE%'`,
    );
    expect(
      uniq.rows.some((r) =>
        /user_id.*api_key_id.*period_start.*period_type/i.test(
          String(r.indexdef),
        ),
      ),
    ).toBe(true);
  });

  it("evaluation_reports_by_key mirrors core scoring columns from evaluation_reports", async () => {
    const cols = await testDb.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name='evaluation_reports_by_key'`,
    );
    const colNames = cols.rows.map((r) => r.column_name);
    for (const required of [
      "id",
      "org_id",
      "user_id",
      "team_id",
      "period_start",
      "period_end",
      "period_type",
      "rubric_id",
      "rubric_version",
      "total_score",
      "section_scores",
      "signals_summary",
      "data_quality",
      "llm_narrative",
      "llm_evidence",
      "llm_model",
      "llm_called_at",
      "llm_cost_usd",
      "llm_upstream_account_id",
      "triggered_by",
      "triggered_by_user",
      "source_breakdown",
      "created_at",
      "updated_at",
      "api_key_id",
      "key_name_snapshot",
    ]) {
      expect(colNames).toContain(required);
    }
  });

  it("llm_usage_events dedup partial unique index exists", async () => {
    const r = await testDb.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename='llm_usage_events' AND indexname='llm_usage_dedup_idx'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0]!.indexdef)).toContain("UNIQUE");
    expect(String(r.rows[0]!.indexdef)).toContain("WHERE");
  });
});
