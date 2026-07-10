import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeOrg,
  makeUser,
  migrationsFolder,
  setupTestDb,
} from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  testDb = await setupTestDb();
});

afterAll(async () => {
  await testDb.stop();
});

describe("migration 0027", () => {
  it("allows the same user and period in different organizations", async () => {
    const firstOrg = await makeOrg(testDb.db);
    const secondOrg = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: firstOrg.id });
    const rubric = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM rubrics
       WHERE org_id IS NULL AND api_key_id IS NULL AND is_default = true
       LIMIT 1`,
    );
    expect(rubric.rows).toHaveLength(1);

    const periodStart = new Date("2026-07-01T00:00:00.000Z");
    const periodEnd = new Date("2026-07-02T00:00:00.000Z");
    const values = {
      userId: user.id,
      rubricId: rubric.rows[0]!.id,
      periodStart,
      periodEnd,
    };

    for (const orgId of [firstOrg.id, secondOrg.id]) {
      await testDb.pool.query(
        `INSERT INTO evaluation_reports (
           org_id, user_id, period_start, period_end, period_type,
           rubric_id, rubric_version, total_score, section_scores,
           signals_summary, data_quality, triggered_by
         ) VALUES ($1, $2, $3, $4, 'daily', $5, '1.0.0', 80,
           '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'manual')`,
        [
          orgId,
          values.userId,
          values.periodStart,
          values.periodEnd,
          values.rubricId,
        ],
      );
    }

    const count = await testDb.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM evaluation_reports
       WHERE user_id = $1 AND period_start = $2 AND period_type = 'daily'`,
      [values.userId, values.periodStart],
    );
    expect(count.rows[0]?.count).toBe("2");
  });

  it("keeps the org-scoped index when rollback cannot restore the old index", async () => {
    const downSql = await readFile(
      path.join(migrationsFolder, "0027_down.sql"),
      "utf8",
    );

    await expect(testDb.pool.query(downSql)).rejects.toThrow();

    const indexes = await testDb.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'evaluation_reports'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain("evaluation_reports_org_period_uniq");
    expect(names).not.toContain("evaluation_reports_period_uniq");
  });
});
