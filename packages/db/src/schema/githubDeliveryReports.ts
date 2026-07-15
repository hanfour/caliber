import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  decimal,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";

/**
 * Per-member GitHub delivery report (spec 2026-07-15). Mirrors the shape
 * of evaluation_reports but is a fully independent track — never summed
 * with the AI-usage score. Populated by PR2 (quant) / PR3 (LLM); the table
 * ships in PR1 so migration 0032 is complete.
 * llm_status: 'ok' | 'skipped' | 'parse_error' | 'budget_denied'
 */
export const githubDeliveryReports = pgTable(
  "github_delivery_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    periodType: text("period_type").notNull(),
    totalScore: decimal("total_score", { precision: 10, scale: 4 }),
    insufficientData: boolean("insufficient_data").notNull().default(false),
    sectionScores: jsonb("section_scores").notNull(),
    // Raw counts + curve inputs, for explainability.
    metrics: jsonb("metrics").notNull(),
    llmQualityAdjustment: decimal("llm_quality_adjustment", {
      precision: 6,
      scale: 2,
    }),
    llmNarrative: text("llm_narrative"),
    llmEvidence: jsonb("llm_evidence"),
    llmStatus: text("llm_status"),
    llmModel: text("llm_model"),
    llmCalledAt: timestamp("llm_called_at", { withTimezone: true }),
    llmCostUsd: decimal("llm_cost_usd", { precision: 20, scale: 10 }),
    triggeredBy: text("triggered_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("github_delivery_reports_user_time_idx").on(
      t.userId,
      t.periodStart,
    ),
    orgTimeIdx: index("github_delivery_reports_org_time_idx").on(
      t.orgId,
      t.periodStart,
    ),
    orgPeriodUniq: uniqueIndex("github_delivery_reports_org_period_uniq").on(
      t.orgId,
      t.userId,
      t.periodStart,
      t.periodType,
    ),
  }),
);
