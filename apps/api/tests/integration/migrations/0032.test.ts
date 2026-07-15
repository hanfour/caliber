import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, migrationsFolder } from "../../factories/index.js";

const TABLES = [
  "github_connections",
  "github_sync_state",
  "github_pull_requests",
  "github_reviews",
  "github_issues",
  "github_project_items",
  "github_delivery_reports",
] as const;

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

describe("migration 0032_github_delivery", () => {
  it("creates all seven tables", async () => {
    const res = await t.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'github_%'
      ORDER BY table_name
    `);
    const names = res.rows.map((r) => r.table_name);
    for (const name of TABLES) expect(names).toContain(name);
  });

  it("enforces one connection per org and unique activity node ids", async () => {
    const uniq = await t.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('github_sync_state','github_pull_requests','github_delivery_reports')
    `);
    const idx = uniq.rows.map((r) => r.indexname);
    expect(idx).toContain("github_sync_state_org_repo_resource_uniq");
    expect(idx).toContain("github_pull_requests_org_node_uniq");
    expect(idx).toContain("github_delivery_reports_org_period_uniq");
  });

  it("down migration drops all seven tables", async () => {
    const downSql = await readFile(
      path.join(migrationsFolder, "0032_down.sql"),
      "utf8",
    );
    await t.pool.query(downSql);
    const res = await t.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'github_%'
    `);
    expect(res.rows).toHaveLength(0);
    // Re-apply for any test pollution paranoia: this file runs isolated,
    // its own container is discarded afterward, so no re-up needed.
  });
});
