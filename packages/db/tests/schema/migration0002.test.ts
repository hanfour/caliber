import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

describe("migration 0002 — evaluator schema", () => {
  const drizzleDir = join(__dirname, "../../drizzle");
  const file = readdirSync(drizzleDir).find(
    (f) => f.startsWith("0002_") && f.endsWith(".sql"),
  );
  if (!file)
    throw new Error(
      "Migration 0002_* not found — run pnpm -F @caliber/db db:generate",
    );
  const sql = readFileSync(join(drizzleDir, file), "utf8");

  it("creates the 4 new tables", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS.*"rubrics"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS.*"request_bodies"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS.*"evaluation_reports"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS.*"gdpr_delete_requests"/);
  });
  it("alters organizations with capture columns", () => {
    expect(sql).toMatch(
      /ALTER TABLE "organizations" ADD COLUMN "content_capture_enabled"/,
    );
  });
  it("creates hot-path indexes", () => {
    expect(sql).toMatch(/CREATE INDEX.*request_bodies_retention_idx/);
    expect(sql).toMatch(/CREATE INDEX.*evaluation_reports_user_time_idx/);
  });
});
