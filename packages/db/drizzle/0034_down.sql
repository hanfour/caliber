-- 0034_down.sql — reverse of 0034_replay_runs.sql
DROP TABLE IF EXISTS "replay_runs";
--> statement-breakpoint
DROP VIEW IF EXISTS "usage_logs_scored";
--> statement-breakpoint
DROP INDEX IF EXISTS "usage_logs_replay_idx";
--> statement-breakpoint
-- 有損：重放列在 rollback 後與一般流量無法區分，會重新計入評分。
-- 若曾實際執行過重放，rollback 前應先 DELETE FROM usage_logs
-- WHERE replay_of_request_id IS NOT NULL。
ALTER TABLE "usage_logs" DROP COLUMN IF EXISTS "replay_of_request_id";
