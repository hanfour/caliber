import { sql } from "drizzle-orm";
import type { TestDb } from "./db.js";

/**
 * Run DDL that drops `usage_logs` columns with the `usage_logs_scored` view
 * temporarily out of the way.
 *
 * Why this exists: migration 0034 creates
 * `CREATE VIEW usage_logs_scored AS SELECT * FROM usage_logs`. Postgres expands
 * the `*` at creation time, so the view records a dependency on EVERY column of
 * `usage_logs` — any later `DROP COLUMN` fails with
 * `2BP01: … view usage_logs_scored depends on column …`.
 *
 * A real rollback never hits that, because it runs newest-first: `0034_down`
 * (which drops the view) has already executed by the time an older `_down`
 * block touches `usage_logs`. The migration tests, though, apply the whole
 * chain and then execute one old `_down` block directly — an ordering that
 * production rollback does not produce. So the tests, not the view, are what
 * has to model the drop.
 *
 * The recreate mirrors `packages/db/drizzle/0034_replay_runs.sql` exactly; keep
 * the two in sync if that migration's view definition ever changes.
 */
export async function withUsageLogsScoredDropped<T>(
  testDb: TestDb,
  runDownSql: () => Promise<T>,
): Promise<T> {
  await testDb.db.execute(sql`DROP VIEW IF EXISTS "usage_logs_scored"`);
  try {
    return await runDownSql();
  } finally {
    // Recreated against whatever columns survived the down block — `SELECT *`
    // re-expands at creation time, same as the migration does.
    await testDb.db.execute(sql`
      CREATE VIEW "usage_logs_scored" AS
        SELECT * FROM "usage_logs" WHERE "replay_of_request_id" IS NULL
    `);
  }
}
