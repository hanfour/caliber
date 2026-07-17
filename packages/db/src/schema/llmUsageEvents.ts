import {
  pgTable,
  uuid,
  text,
  integer,
  decimal,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

export const llmUsageEvents = pgTable(
  "llm_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(), // 'facet_extraction' | 'deep_analysis'
    model: text("model").notNull(),
    tokensInput: integer("tokens_input").notNull(),
    tokensOutput: integer("tokens_output").notNull(),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull(),
    refType: text("ref_type"), // 'request_body_facet' | 'evaluation_report' | null
    refId: uuid("ref_id"),
    /**
     * v3 (0033): the upstream call's x-request-id — one ledger row per real
     * upstream call. Dedups on this (via `llm_usage_request_dedup_idx`,
     * migration-only — see 0022's note that drizzle-kit does not emit WHERE
     * clauses on partial indexes) instead of the legacy
     * `(ref_type, ref_id, event_type)` index, which keys on a STABLE report
     * id and so swallowed real re-spends (e.g. a manual regenerate) as
     * dedup no-ops, leaving `getMonthSpend` under-counted. NULL (legacy rows
     * + the facet writer, which has no request id) is exempt from dedup.
     */
    usageLogRequestId: text("usage_log_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgMonthIdx: index("llm_usage_org_month_idx").on(t.orgId, t.createdAt),
  }),
);
