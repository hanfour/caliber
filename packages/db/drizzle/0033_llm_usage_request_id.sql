-- 0033_llm_usage_request_id.sql
-- Ledger dedup by the upstream call's request id (#270). The existing
-- (ref_type, ref_id, event_type) index keys on a STABLE report id, so a
-- manual regenerate re-spends LLM money but is dedup-swallowed — month-spend
-- then under-counts and the budget gate goes blind. One row per real upstream
-- call; BullMQ retries of the SAME call still dedup because they reuse the
-- same x-request-id. NULL is exempt (legacy rows + the facet writer).
ALTER TABLE "llm_usage_events" ADD COLUMN "usage_log_request_id" text;
--> statement-breakpoint
-- Narrow the legacy dedup guard (0022) to rows WITHOUT a request id (legacy
-- rows + the facet writer, which has no request id to persist). Without this
-- narrowing, the legacy index would still fire a hard unique-violation on a
-- real deep-analysis regenerate (same ref_type/ref_id/event_type, different
-- request id) because `onConflictDoNothing` only arbitrates the ONE index
-- named as its target — a conflict on a DIFFERENT unique index is not
-- swallowed, it errors. Recreated (not altered in place: Postgres has no
-- ALTER INDEX ... WHERE) with the identical name so no application code or
-- prior tooling needs to change.
DROP INDEX IF EXISTS "llm_usage_dedup_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_dedup_idx" ON "llm_usage_events" ("ref_type", "ref_id", "event_type") WHERE "ref_id" IS NOT NULL AND "usage_log_request_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_request_dedup_idx" ON "llm_usage_events" ("usage_log_request_id") WHERE "usage_log_request_id" IS NOT NULL;
