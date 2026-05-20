-- Phase 1 follow-up: evaluator integration.
-- 1) Adds the `evaluator_events` view that unions transcript-source events
--    (client_events joined to client_sessions) with gateway-source captures
--    (request_bodies joined to usage_logs). Per spec Resolved O3, v1 does NOT
--    fuzzy-join the two streams — they coexist as independent source rows.
-- 2) Adds transcript-only facet columns on request_body_facets so the future
--    cron cutover can populate them without another migration.
-- 3) Adds `source_breakdown` jsonb on evaluation_reports so reviewers can see
--    which path produced each report's data.

ALTER TABLE "evaluation_reports"
  ADD COLUMN "source_breakdown" jsonb;
--> statement-breakpoint

ALTER TABLE "request_body_facets"
  ADD COLUMN "subagent_call_count" integer;
--> statement-breakpoint
ALTER TABLE "request_body_facets"
  ADD COLUMN "reasoning_token_ratio" numeric(5, 4);
--> statement-breakpoint
ALTER TABLE "request_body_facets"
  ADD COLUMN "tool_use_diversity" integer;
--> statement-breakpoint
ALTER TABLE "request_body_facets"
  ADD COLUMN "session_topology" text;
--> statement-breakpoint

CREATE VIEW "evaluator_events" AS
  SELECT
    ce.session_id,
    ce.event_id,
    ce.event_type,
    ce.role,
    ce.timestamp,
    ce.input_tokens,
    ce.output_tokens,
    ce.cache_read_tokens,
    ce.cache_creation_tokens,
    ce.reasoning_tokens,
    ce.content,
    cs.org_id,
    cs.user_id,
    cs.device_id,
    cs.source_client,
    cs.cwd,
    cs.git_commit_hash,
    cs.git_branch,
    ce.source                 AS event_source
  FROM client_events ce
  JOIN client_sessions cs ON cs.id = ce.session_id
  WHERE ce.source = 'transcript'

  UNION ALL

  SELECT
    ('gw-' || rb.request_id)  AS session_id,
    rb.request_id             AS event_id,
    'gateway_capture'         AS event_type,
    'tool'                    AS role,
    rb.captured_at            AS timestamp,
    ul.input_tokens           AS input_tokens,
    ul.output_tokens          AS output_tokens,
    ul.cache_read_tokens      AS cache_read_tokens,
    ul.cache_creation_tokens  AS cache_creation_tokens,
    NULL::integer             AS reasoning_tokens,
    jsonb_build_object(
      'request_id', rb.request_id,
      'note',       'gateway-side capture; body in request_bodies'
    )                         AS content,
    rb.org_id,
    ul.user_id                AS user_id,
    ul.device_id              AS device_id,
    'gateway-capture'         AS source_client,
    NULL::text                AS cwd,
    NULL::text                AS git_commit_hash,
    NULL::text                AS git_branch,
    'gateway'                 AS event_source
  FROM request_bodies rb
  JOIN usage_logs ul ON ul.request_id = rb.request_id;
