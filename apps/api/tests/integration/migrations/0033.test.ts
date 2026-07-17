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

  it("down migration collapses duplicate (ref_type, ref_id, event_type) rows — keeping the earliest — before rebuilding the unscoped index, then drops the column", async () => {
    // Representative shape 0033 exists to allow: a manual regenerate (or a
    // legacy-NULL row plus a new request-id row for the same report)
    // produces two rows sharing (ref_type, ref_id, event_type) once ref_id
    // IS NOT NULL, distinguished only by usage_log_request_id. Both succeed
    // under 0033's up-migration index — a naive rollback that just
    // recreates the unscoped-by-request-id unique index would then hit a
    // duplicate-key error on exactly this data.
    const org = await makeOrg(t.db);
    const refId = crypto.randomUUID();
    const row = (opts: {
      model: string;
      usageLogRequestId: string;
      createdAt: Date;
    }) => ({
      orgId: org.id,
      eventType: "deep_analysis",
      model: opts.model,
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: "0.001",
      refType: "evaluation_report",
      refId,
      usageLogRequestId: opts.usageLogRequestId,
      createdAt: opts.createdAt,
    });
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    await t.db.insert(llmUsageEvents).values(
      row({ model: "keep-me-earliest", usageLogRequestId: "req-earliest", createdAt: earlier }),
    );
    await t.db.insert(llmUsageEvents).values(
      row({ model: "drop-me-latest", usageLogRequestId: "req-latest", createdAt: later }),
    );

    const downSql = await readFile(
      path.join(migrationsFolder, "0033_down.sql"),
      "utf8",
    );
    await t.pool.query(downSql);

    const cols = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'llm_usage_events' AND column_name = 'usage_log_request_id'`);
    expect(cols.rows).toHaveLength(0);

    const survivors = await t.db.execute<{ model: string }>(sql`
      SELECT model FROM llm_usage_events
      WHERE ref_type = 'evaluation_report' AND ref_id = ${refId} AND event_type = 'deep_analysis'`);
    expect(survivors.rows).toHaveLength(1);
    expect(survivors.rows[0]!.model).toBe("keep-me-earliest");

    // The rebuilt unscoped index is intact and enforces uniqueness again.
    await expect(
      t.db.insert(llmUsageEvents).values({
        orgId: org.id,
        eventType: "deep_analysis",
        model: "post-rollback-dup",
        tokensInput: 1,
        tokensOutput: 1,
        costUsd: "0.001",
        refType: "evaluation_report",
        refId,
      }),
    ).rejects.toThrow();
  });
});
