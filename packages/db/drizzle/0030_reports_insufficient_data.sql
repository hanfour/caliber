-- 0030: rubric v2 — nullable total_score + insufficient_data flag on both report tables
--> statement-breakpoint
ALTER TABLE "evaluation_reports" ALTER COLUMN "total_score" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "evaluation_reports" ADD COLUMN "insufficient_data" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ALTER COLUMN "total_score" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD COLUMN "insufficient_data" boolean NOT NULL DEFAULT false;
