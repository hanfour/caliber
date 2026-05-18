-- Down migration for 0013_multi_source_ingest_phase1.

ALTER TABLE "request_bodies" DROP COLUMN IF EXISTS "source";
--> statement-breakpoint
ALTER TABLE "request_bodies" DROP COLUMN IF EXISTS "device_id";
--> statement-breakpoint
ALTER TABLE "usage_logs" DROP COLUMN IF EXISTS "device_id";
--> statement-breakpoint
-- Partitions are dropped automatically when the parent table is dropped, but
-- listed explicitly so an operator can DETACH first if they want to preserve data.
DROP TABLE IF EXISTS "client_events_2026_08";
--> statement-breakpoint
DROP TABLE IF EXISTS "client_events_2026_07";
--> statement-breakpoint
DROP TABLE IF EXISTS "client_events_2026_06";
--> statement-breakpoint
DROP TABLE IF EXISTS "client_events_2026_05";
--> statement-breakpoint
DROP TABLE IF EXISTS "client_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "client_sessions";
--> statement-breakpoint
DROP TABLE IF EXISTS "device_api_keys";
--> statement-breakpoint
DROP TABLE IF EXISTS "device_enrollment_tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "devices";
