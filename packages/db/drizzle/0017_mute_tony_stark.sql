CREATE TABLE "org_redaction_patterns" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"patterns" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"api_key_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"internal_request_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_model" text NOT NULL,
	"surface" text NOT NULL,
	"platform" text NOT NULL,
	"status_code" integer NOT NULL,
	"total_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"actual_cost_usd" numeric(20, 10) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_records_api_key_id_request_id_pk" PRIMARY KEY("api_key_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "org_redaction_patterns" ADD CONSTRAINT "org_redaction_patterns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_records_org_created_idx" ON "idempotency_records" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "credential_vault" DROP COLUMN "cipher_version";--> statement-breakpoint
ALTER TABLE "request_bodies" DROP COLUMN "cipher_version";