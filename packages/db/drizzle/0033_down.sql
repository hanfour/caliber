-- 0033_down.sql — reverse of 0033_llm_usage_request_id.sql
DROP INDEX IF EXISTS "llm_usage_request_dedup_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "llm_usage_dedup_idx";
--> statement-breakpoint
-- Collapse duplicates before rebuilding the unscoped-by-request-id unique
-- index below. 0033 exists specifically to let a manual regenerate (or a
-- legacy-NULL row plus a new request-id row for the same report) coexist as
-- two rows sharing (ref_type, ref_id, event_type) once ref_id IS NOT NULL —
-- exactly the data this rollback's CREATE UNIQUE INDEX would otherwise fail
-- a duplicate-key error against. This is intentionally lossy: the pre-0033
-- schema had no way to represent more than one ledger row per
-- (ref_type, ref_id, event_type), so rollback re-merges those rows back
-- down to one, keeping the earliest (by created_at, tied-broken by id) and
-- discarding the rest. NULL-ref_id rows are untouched (already exempt from
-- this index's predicate).
DELETE FROM "llm_usage_events" t
USING (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "ref_type", "ref_id", "event_type"
           ORDER BY "created_at" ASC, "id" ASC
         ) AS rn
  FROM "llm_usage_events"
  WHERE "ref_id" IS NOT NULL
) dup
WHERE t."id" = dup."id" AND dup."rn" > 1;
--> statement-breakpoint
-- Restore the original 0022 definition (unscoped by request id).
CREATE UNIQUE INDEX "llm_usage_dedup_idx" ON "llm_usage_events" ("ref_type", "ref_id", "event_type") WHERE "ref_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "usage_log_request_id";
