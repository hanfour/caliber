-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with ON_ERROR_STOP so psql exits non-zero on any failure:
--   psql --set ON_ERROR_STOP=1 "$DATABASE_URL" -f packages/db/drizzle/0027_down.sql
--
-- Restoring the old index can fail after 0027 has accepted reports for the
-- same user and period in multiple organizations. Keep both DDL statements in
-- one transaction so that failure preserves the org-scoped unique index.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_reports_period_uniq"
  ON "evaluation_reports" ("user_id", "period_start", "period_type");
DROP INDEX IF EXISTS "evaluation_reports_org_period_uniq";

COMMIT;
