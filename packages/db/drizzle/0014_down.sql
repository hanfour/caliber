-- Reverse of 0014. View dropped first; columns dropped last. Idempotent.

DROP VIEW IF EXISTS "evaluator_events";

ALTER TABLE "request_body_facets" DROP COLUMN IF EXISTS "session_topology";
ALTER TABLE "request_body_facets" DROP COLUMN IF EXISTS "tool_use_diversity";
ALTER TABLE "request_body_facets" DROP COLUMN IF EXISTS "reasoning_token_ratio";
ALTER TABLE "request_body_facets" DROP COLUMN IF EXISTS "subagent_call_count";

ALTER TABLE "evaluation_reports" DROP COLUMN IF EXISTS "source_breakdown";
