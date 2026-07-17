import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, migrationsFolder, makeOrg } from "../../factories/index.js";
import { llmUsageEvents } from "@caliber/db";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

describe("migration 0033_llm_usage_request_id", () => {
  it("adds usage_log_request_id and its partial unique index", async () => {
    const cols = await t.db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'llm_usage_events' AND column_name = 'usage_log_request_id'`);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]!.is_nullable).toBe("YES");
    const idx = await t.db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'llm_usage_events'`);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("llm_usage_request_dedup_idx");
    expect(names).toContain("llm_usage_dedup_idx"); // legacy index survives
  });

  it("the new index dedups by request id and tolerates NULLs", async () => {
    const org = await makeOrg(t.db);
    const row = (rid: string | null) => ({
      orgId: org.id,
      eventType: "deep_analysis",
      model: "m",
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: "0.001",
      usageLogRequestId: rid,
    });
    await t.db.insert(llmUsageEvents).values(row("req-1"));
    await expect(t.db.insert(llmUsageEvents).values(row("req-1"))).rejects.toThrow();
    // NULLs are exempt (legacy/facet rows)
    await t.db.insert(llmUsageEvents).values(row(null));
    await t.db.insert(llmUsageEvents).values(row(null));
  });

  it("down migration drops the column and its index", async () => {
    const downSql = await readFile(
      path.join(migrationsFolder, "0033_down.sql"),
      "utf8",
    );
    await t.pool.query(downSql);
    const cols = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'llm_usage_events' AND column_name = 'usage_log_request_id'`);
    expect(cols.rows).toHaveLength(0);
  });
});
