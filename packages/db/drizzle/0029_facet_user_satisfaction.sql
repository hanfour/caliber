-- 0029: rubric v2 — LLM-judged user satisfaction facet (docs/RUBRIC_V2_DESIGN.md §5)
--> statement-breakpoint
ALTER TABLE "request_body_facets" ADD COLUMN "user_satisfaction" smallint;
