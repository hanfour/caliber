-- 0033_down.sql — reverse of 0033_llm_usage_request_id.sql
DROP INDEX IF EXISTS "llm_usage_request_dedup_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "llm_usage_dedup_idx";
--> statement-breakpoint
-- Restore the original 0022 definition (unscoped by request id).
CREATE UNIQUE INDEX "llm_usage_dedup_idx" ON "llm_usage_events" ("ref_type", "ref_id", "event_type") WHERE "ref_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "usage_log_request_id";
