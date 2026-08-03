-- 0034_replay_runs.sql
-- 單筆請求重放。`replay_of_request_id` 標記重放流量；`usage_logs_scored`
-- 讓評分側預設看不到它——在 14 個查詢點各補 WHERE 是「今天做對、半年後被新
-- 程式碼默默破壞」的解法，而破壞的形式是某人的考績多了幾分，不會有人察覺。
ALTER TABLE "usage_logs" ADD COLUMN "replay_of_request_id" text;
--> statement-breakpoint
-- partial index：非重放列（絕大多數）不佔索引空間。
CREATE INDEX "usage_logs_replay_idx" ON "usage_logs" ("replay_of_request_id")
  WHERE "replay_of_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE VIEW "usage_logs_scored" AS
  SELECT * FROM "usage_logs" WHERE "replay_of_request_id" IS NULL;
--> statement-breakpoint
CREATE TABLE "replay_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "source_request_id" text NOT NULL REFERENCES "usage_logs"("request_id") ON DELETE cascade,
  "replay_request_id" text,
  "target_model" text NOT NULL,
  "triggered_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "status" text DEFAULT 'queued' NOT NULL,
  "failure_reason" text,
  "fidelity" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "replay_runs_org_time_idx" ON "replay_runs" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "replay_runs_source_idx" ON "replay_runs" ("source_request_id");
