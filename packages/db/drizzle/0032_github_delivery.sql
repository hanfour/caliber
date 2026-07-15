-- 0032_github_delivery.sql
-- GitHub delivery scoring PR1 (spec 2026-07-15): org PAT connection,
-- sync watermarks, activity metadata, delivery reports.
CREATE TABLE "github_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE cascade,
  "owner_login" text NOT NULL,
  "nonce" bytea NOT NULL,
  "ciphertext" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "token_last4" text NOT NULL,
  "repo_allowlist" jsonb,
  "delivery_enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'ok',
  "last_sync_at" timestamp with time zone,
  "last_sync_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "github_sync_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "resource_type" text NOT NULL,
  "watermark" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_sync_state_org_repo_resource_uniq"
  ON "github_sync_state" ("org_id","repo_full_name","resource_type");
--> statement-breakpoint
CREATE TABLE "github_pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "number" integer NOT NULL,
  "gh_node_id" text NOT NULL,
  "author_gh_id" bigint,
  "author_login" text,
  "state" text NOT NULL,
  "draft" boolean NOT NULL DEFAULT false,
  "title" text NOT NULL,
  "html_url" text NOT NULL,
  "base_ref" text NOT NULL,
  "additions" integer NOT NULL DEFAULT 0,
  "deletions" integer NOT NULL DEFAULT 0,
  "changed_files" integer NOT NULL DEFAULT 0,
  "commit_count" integer NOT NULL DEFAULT 0,
  "review_comment_count" integer NOT NULL DEFAULT 0,
  "gh_created_at" timestamp with time zone NOT NULL,
  "merged_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_pull_requests_org_node_uniq"
  ON "github_pull_requests" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_pull_requests_org_author_idx"
  ON "github_pull_requests" ("org_id","author_gh_id");
--> statement-breakpoint
CREATE INDEX "github_pull_requests_org_merged_idx"
  ON "github_pull_requests" ("org_id","merged_at");
--> statement-breakpoint
CREATE TABLE "github_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "gh_node_id" text NOT NULL,
  "pr_gh_node_id" text NOT NULL,
  "reviewer_gh_id" bigint,
  "reviewer_login" text,
  "state" text NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_reviews_org_node_uniq"
  ON "github_reviews" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_reviews_org_reviewer_idx"
  ON "github_reviews" ("org_id","reviewer_gh_id");
--> statement-breakpoint
CREATE TABLE "github_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "repo_full_name" text NOT NULL,
  "number" integer NOT NULL,
  "gh_node_id" text NOT NULL,
  "author_gh_id" bigint,
  "author_login" text,
  "assignee_gh_ids" jsonb NOT NULL,
  "state" text NOT NULL,
  "state_reason" text,
  "closed_by_gh_id" bigint,
  "title" text NOT NULL,
  "html_url" text NOT NULL,
  "gh_created_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_issues_org_node_uniq"
  ON "github_issues" ("org_id","gh_node_id");
--> statement-breakpoint
CREATE INDEX "github_issues_org_author_idx"
  ON "github_issues" ("org_id","author_gh_id");
--> statement-breakpoint
CREATE INDEX "github_issues_org_closed_idx"
  ON "github_issues" ("org_id","closed_at");
--> statement-breakpoint
CREATE TABLE "github_project_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "project_node_id" text NOT NULL,
  "project_title" text NOT NULL,
  "item_node_id" text NOT NULL,
  "content_type" text NOT NULL,
  "content_gh_node_id" text,
  "assignee_gh_ids" jsonb NOT NULL,
  "status_value" text,
  "is_done" boolean NOT NULL DEFAULT false,
  "gh_updated_at" timestamp with time zone NOT NULL,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_project_items_org_item_uniq"
  ON "github_project_items" ("org_id","item_node_id");
--> statement-breakpoint
CREATE INDEX "github_project_items_org_done_idx"
  ON "github_project_items" ("org_id","is_done");
--> statement-breakpoint
CREATE TABLE "github_delivery_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "period_type" text NOT NULL,
  "total_score" numeric(10,4),
  "insufficient_data" boolean NOT NULL DEFAULT false,
  "section_scores" jsonb NOT NULL,
  "metrics" jsonb NOT NULL,
  "llm_quality_adjustment" numeric(6,2),
  "llm_narrative" text,
  "llm_evidence" jsonb,
  "llm_status" text,
  "llm_model" text,
  "llm_called_at" timestamp with time zone,
  "llm_cost_usd" numeric(20,10),
  "triggered_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "github_delivery_reports_user_time_idx"
  ON "github_delivery_reports" ("user_id","period_start");
--> statement-breakpoint
CREATE INDEX "github_delivery_reports_org_time_idx"
  ON "github_delivery_reports" ("org_id","period_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "github_delivery_reports_org_period_uniq"
  ON "github_delivery_reports" ("org_id","user_id","period_start","period_type");
