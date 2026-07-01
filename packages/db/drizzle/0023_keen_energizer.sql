-- Hand-verified: partial unique index WHERE clause and CHECK constraint are correct.
-- down: ALTER TABLE rubrics DROP CONSTRAINT rubrics_key_scope_chk; DROP INDEX rubrics_api_key_uniq; ALTER TABLE rubrics DROP CONSTRAINT rubrics_api_key_id_api_keys_id_fk; ALTER TABLE rubrics DROP COLUMN api_key_id;
ALTER TABLE "rubrics" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rubrics_api_key_uniq" ON "rubrics" USING btree ("api_key_id") WHERE api_key_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_key_scope_chk" CHECK (api_key_id IS NULL OR (org_id IS NOT NULL AND is_default = false));
