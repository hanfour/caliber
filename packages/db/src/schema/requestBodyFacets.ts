import {
  pgTable,
  uuid,
  text,
  smallint,
  integer,
  decimal,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { requestBodies } from "./requestBodies.js";

/**
 * request_body_facets — per-session LLM-extracted classification fields.
 *
 * One-to-one with request_bodies (UNIQUE on request_id). On a failed
 * extraction we still write a row with extraction_error set and the facet
 * fields left null, so all enum-like columns are nullable.
 */
export const requestBodyFacets = pgTable(
  "request_body_facets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // request_bodies.requestId is TEXT (Plan 4B). One facet row per body.
    requestId: text("request_id")
      .notNull()
      .unique()
      .references(() => requestBodies.requestId, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // session_type ∈ feature_dev | bug_fix | refactor | exploration | other
    sessionType: text("session_type"),
    // outcome ∈ success | partial | failure | abandoned
    outcome: text("outcome"),
    // claude_helpfulness ∈ 1..5
    claudeHelpfulness: smallint("claude_helpfulness"),
    frictionCount: integer("friction_count"),
    bugsCaughtCount: integer("bugs_caught_count"),
    codexErrorsCount: integer("codex_errors_count"),
    /** v2 (0029): LLM-judged user satisfaction 1..5; NULL on prompt-v1 rows. */
    userSatisfaction: smallint("user_satisfaction"),
    // Phase 1 (0014) transcript-only signals. Populated by the future
    // evaluator-on-evaluator_events cron; NULL on gateway-source-only rows.
    subagentCallCount: integer("subagent_call_count"),
    reasoningTokenRatio: decimal("reasoning_token_ratio", {
      precision: 5,
      scale: 4,
    }),
    toolUseDiversity: integer("tool_use_diversity"),
    // session_topology ∈ linear | branching | deep_tree
    sessionTopology: text("session_topology"),
    extractedAt: timestamp("extracted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    extractedWithModel: text("extracted_with_model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    extractionError: text("extraction_error"),
  },
  (t) => ({
    orgExtractedIdx: index("request_body_facets_org_extracted_idx").on(
      t.orgId,
      t.extractedAt,
    ),
    promptVersionIdx: index("request_body_facets_prompt_version_idx").on(
      t.promptVersion,
    ),
  }),
);
