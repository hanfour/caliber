CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_reports_org_period_uniq"
  ON "evaluation_reports" ("org_id", "user_id", "period_start", "period_type");
DROP INDEX IF EXISTS "evaluation_reports_period_uniq";
