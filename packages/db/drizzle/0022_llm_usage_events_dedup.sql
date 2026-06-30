-- Hand-authored: drizzle-kit does not emit WHERE clauses on partial indexes.
--
-- Dedup guard for llm_usage_events: prevents duplicate LLM cost ledger entries
-- for the same (ref_type, ref_id, event_type) combination. The partial index
-- only applies when ref_id IS NOT NULL (i.e. events that are linked to a
-- specific entity such as a request_body_facet or evaluation_report).
-- Null ref_id rows (anonymous / standalone events) are excluded from dedup.
--
-- down: DROP INDEX llm_usage_dedup_idx;
CREATE UNIQUE INDEX llm_usage_dedup_idx ON llm_usage_events (ref_type, ref_id, event_type) WHERE ref_id IS NOT NULL;
