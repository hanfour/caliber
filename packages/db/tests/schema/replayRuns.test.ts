import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { replayRuns } from "../../src/schema/replayRuns";
import { usageLogs } from "../../src/schema/usageLogs";

describe("replayRuns schema", () => {
  it("exports every replay_runs column", () => {
    const cols = Object.keys(replayRuns);
    for (const c of [
      "id",
      "orgId",
      "sourceRequestId",
      "replayRequestId",
      "targetModel",
      "triggeredBy",
      "status",
      "failureReason",
      "fidelity",
      "createdAt",
      "completedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});

describe("usageLogs schema — replay column", () => {
  it("exports replayOfRequestId", () => {
    const cols = Object.keys(usageLogs);
    expect(cols).toContain("replayOfRequestId");
  });

  // Pins the TS index definition to the PARTIAL index actually created by
  // 0034_replay_runs.sql (`WHERE "replay_of_request_id" IS NOT NULL`).
  // Without this, usage_logs_replay_idx could silently regress to a full
  // index in TS (misrepresenting the DB) with no test catching it — the
  // exact drift class the migration's own header comment warns about.
  it("usage_logs_replay_idx is a partial index scoped to non-null replayOfRequestId", () => {
    const { indexes } = getTableConfig(usageLogs);
    const replayIdx = indexes.find(
      (idx) => idx.config.name === "usage_logs_replay_idx",
    );
    expect(replayIdx).toBeDefined();
    expect(replayIdx?.config.where).toBeDefined();

    const { sql: whereSql } = new PgDialect().sqlToQuery(
      replayIdx!.config.where!,
    );
    expect(whereSql).toBe('"usage_logs"."replay_of_request_id" IS NOT NULL');
  });
});

describe("migration 0034_replay_runs.sql", () => {
  const drizzleDir = join(__dirname, "../../drizzle");
  const sql = readFileSync(join(drizzleDir, "0034_replay_runs.sql"), "utf8");

  it("adds the replay_of_request_id column to usage_logs", () => {
    expect(sql).toMatch(
      /ALTER TABLE "usage_logs" ADD COLUMN "replay_of_request_id" text/,
    );
  });

  it("creates the usage_logs_replay_idx partial index", () => {
    expect(sql).toMatch(
      /CREATE INDEX "usage_logs_replay_idx" ON "usage_logs" \("replay_of_request_id"\)\s+WHERE "replay_of_request_id" IS NOT NULL/,
    );
  });

  it("creates the usage_logs_scored view filtering out replay rows", () => {
    expect(sql).toMatch(
      /CREATE VIEW "usage_logs_scored" AS\s+SELECT \* FROM "usage_logs" WHERE "replay_of_request_id" IS NULL/,
    );
  });

  it("creates the replay_runs table", () => {
    expect(sql).toMatch(/CREATE TABLE "replay_runs"/);
    expect(sql).toMatch(/"source_request_id" text NOT NULL REFERENCES "usage_logs"\("request_id"\)/);
    expect(sql).toMatch(/"triggered_by" uuid NOT NULL REFERENCES "users"\("id"\)/);
  });

  it("creates the replay_runs indexes", () => {
    expect(sql).toMatch(
      /CREATE INDEX "replay_runs_org_time_idx" ON "replay_runs" \("org_id", "created_at"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "replay_runs_source_idx" ON "replay_runs" \("source_request_id"\)/,
    );
  });

  it("separates every statement with a drizzle statement-breakpoint", () => {
    expect(sql.match(/--> statement-breakpoint/g)?.length).toBe(5);
  });
});

describe("migration 0034_down.sql", () => {
  const drizzleDir = join(__dirname, "../../drizzle");
  const sql = readFileSync(join(drizzleDir, "0034_down.sql"), "utf8");

  it("drops replay_runs, the view, the index, then the column — reverse order of 0034_replay_runs.sql", () => {
    const tableIdx = sql.indexOf('DROP TABLE IF EXISTS "replay_runs"');
    const viewIdx = sql.indexOf('DROP VIEW IF EXISTS "usage_logs_scored"');
    const indexIdx = sql.indexOf('DROP INDEX IF EXISTS "usage_logs_replay_idx"');
    const columnIdx = sql.indexOf(
      'ALTER TABLE "usage_logs" DROP COLUMN IF EXISTS "replay_of_request_id"',
    );
    for (const idx of [tableIdx, viewIdx, indexIdx, columnIdx]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(tableIdx).toBeLessThan(viewIdx);
    expect(viewIdx).toBeLessThan(indexIdx);
    expect(indexIdx).toBeLessThan(columnIdx);
  });
});

describe("meta/_journal.json", () => {
  const journal = JSON.parse(
    readFileSync(join(__dirname, "../../drizzle/meta/_journal.json"), "utf8"),
  );

  it("contains the 0034_replay_runs entry", () => {
    expect(journal.entries).toContainEqual({
      idx: 34,
      version: "7",
      when: 1783699000005,
      tag: "0034_replay_runs",
      breakpoints: true,
    });
  });
});
