UPDATE "evaluation_reports" SET "total_score" = 0 WHERE "total_score" IS NULL;
ALTER TABLE "evaluation_reports" ALTER COLUMN "total_score" SET NOT NULL;
ALTER TABLE "evaluation_reports" DROP COLUMN IF EXISTS "insufficient_data";
UPDATE "evaluation_reports_by_key" SET "total_score" = 0 WHERE "total_score" IS NULL;
ALTER TABLE "evaluation_reports_by_key" ALTER COLUMN "total_score" SET NOT NULL;
ALTER TABLE "evaluation_reports_by_key" DROP COLUMN IF EXISTS "insufficient_data";
