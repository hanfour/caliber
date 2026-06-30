CREATE TABLE "evaluation_reports_by_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"period_type" text NOT NULL,
	"rubric_id" uuid NOT NULL,
	"rubric_version" text NOT NULL,
	"total_score" numeric(10, 4) NOT NULL,
	"section_scores" jsonb NOT NULL,
	"signals_summary" jsonb NOT NULL,
	"data_quality" jsonb NOT NULL,
	"llm_narrative" text,
	"llm_evidence" jsonb,
	"llm_model" text,
	"llm_called_at" timestamp with time zone,
	"llm_cost_usd" numeric(20, 10),
	"llm_upstream_account_id" uuid,
	"triggered_by" text NOT NULL,
	"triggered_by_user" uuid,
	"source_breakdown" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"key_name_snapshot" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "evaluate_as_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_rubric_id_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_llm_upstream_account_id_upstream_accounts_id_fk" FOREIGN KEY ("llm_upstream_account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_triggered_by_user_users_id_fk" FOREIGN KEY ("triggered_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_reports_by_key" ADD CONSTRAINT "evaluation_reports_by_key_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_reports_by_key_uniq" ON "evaluation_reports_by_key" USING btree ("user_id","api_key_id","period_start","period_type");--> statement-breakpoint
CREATE INDEX "erbk_api_key_time_idx" ON "evaluation_reports_by_key" USING btree ("api_key_id","period_start");--> statement-breakpoint
CREATE INDEX "erbk_org_time_idx" ON "evaluation_reports_by_key" USING btree ("org_id","period_start");--> statement-breakpoint
CREATE INDEX "erbk_user_time_idx" ON "evaluation_reports_by_key" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "erbk_team_time_idx" ON "evaluation_reports_by_key" USING btree ("team_id","period_start");--> statement-breakpoint
CREATE INDEX "api_keys_eval_project_idx" ON "api_keys" USING btree ("org_id") WHERE "api_keys"."evaluate_as_project" = true AND "api_keys"."revoked_at" IS NULL;