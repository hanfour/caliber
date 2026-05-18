CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"agent_version" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_api_keys" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_session_id" text,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"source_client" text NOT NULL,
	"cwd" text,
	"git_commit_hash" text,
	"git_branch" text,
	"git_remote_url" text,
	"cli_version" text,
	"model_provider" text,
	"base_instructions_hash" text,
	"base_instructions_text" text,
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- client_events is RANGE-partitioned by ingested_at (monthly). PK and UNIQUE
-- include ingested_at because postgres requires every uniqueness constraint
-- on a partitioned table to include all partition-key columns. Cross-partition
-- dedup (daemon paused > 1 month then retries) is handled at evaluator layer;
-- in-partition retries (~60s daemon flush cadence) are caught by the UNIQUE
-- constraint. Initial partitions cover current month + next 3 months; a daily
-- cron rolls partitions forward (see Phase 1 cron deliverable).
CREATE TABLE IF NOT EXISTS "client_events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"event_id" text NOT NULL,
	"parent_event_id" text,
	"turn_id" text,
	"role" text,
	"event_type" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"content" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_creation_tokens" integer,
	"reasoning_tokens" integer,
	"source" text DEFAULT 'transcript' NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_events_id_ingested_at_pk" PRIMARY KEY("id","ingested_at"),
	CONSTRAINT "client_events_dedup_key" UNIQUE("session_id","event_id","source","ingested_at")
) PARTITION BY RANGE ("ingested_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_events_2026_05" PARTITION OF "client_events"
	FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_events_2026_06" PARTITION OF "client_events"
	FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_events_2026_07" PARTITION OF "client_events"
	FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_events_2026_08" PARTITION OF "client_events"
	FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "request_bodies" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "request_bodies" ADD COLUMN "source" text DEFAULT 'gateway' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_enrollment_tokens" ADD CONSTRAINT "device_enrollment_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_enrollment_tokens" ADD CONSTRAINT "device_enrollment_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_enrollment_tokens" ADD CONSTRAINT "device_enrollment_tokens_used_by_device_id_devices_id_fk" FOREIGN KEY ("used_by_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_api_keys" ADD CONSTRAINT "device_api_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_parent_session_id_client_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."client_sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_events" ADD CONSTRAINT "client_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_events" ADD CONSTRAINT "client_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_events" ADD CONSTRAINT "client_events_session_id_client_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."client_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_user_idx" ON "devices" USING btree ("user_id") WHERE "devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_org_idx" ON "devices" USING btree ("org_id") WHERE "devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_enrollment_tokens_expires_idx" ON "device_enrollment_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_sessions_org_user_idx" ON "client_sessions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_sessions_device_idx" ON "client_sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_sessions_parent_idx" ON "client_sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_events_session_ts" ON "client_events" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_events_org_ts" ON "client_events" USING btree ("org_id","timestamp");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
