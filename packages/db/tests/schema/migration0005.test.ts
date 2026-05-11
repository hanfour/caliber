import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

describe("gateway schema migration", () => {
  // drizzle-kit generates migrations on top of the existing baseline.
  // The 0001_* migration contains the table creation (this is what we check).
  // A 0002_* migration may also exist if schema was regenerated (e.g., fixing defaults).
  const drizzleDir = join(__dirname, "../../drizzle");
  const files = readdirSync(drizzleDir).filter(
    (f) => /^\d{4}_/.test(f) && f.endsWith(".sql"),
  );
  if (files.length === 0)
    throw new Error(
      "No migration files found — run pnpm -F @caliber/db db:generate",
    );
  // Find the 0001_* file which has the table creation
  const file = files.find((f) => f.startsWith("0001_"));
  if (!file)
    throw new Error(
      "Migration 0001_* not found — run pnpm -F @caliber/db db:generate",
    );
  const sql = readFileSync(join(drizzleDir, file), "utf8");

  it("creates the 4 new tables", () => {
    expect(sql).toMatch(/CREATE TABLE.*"upstream_accounts"/);
    expect(sql).toMatch(/CREATE TABLE.*"credential_vault"/);
    expect(sql).toMatch(/CREATE TABLE.*"api_keys"/);
    expect(sql).toMatch(/CREATE TABLE.*"usage_logs"/);
  });
  it("creates hot-path indexes", () => {
    expect(sql).toMatch(/CREATE INDEX.*upstream_accounts_select_idx/);
    expect(sql).toMatch(/CREATE INDEX.*usage_logs_user_time_idx/);
  });
});
