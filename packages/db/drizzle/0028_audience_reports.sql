ALTER TABLE "evaluation_reports" ADD COLUMN "llm_user_report" jsonb;--> statement-breakpoint
ALTER TABLE "evaluation_reports" ADD COLUMN "llm_admin_report" jsonb;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD COLUMN "llm_user_report" jsonb;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD COLUMN "llm_admin_report" jsonb;