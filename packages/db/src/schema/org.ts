import {
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  boolean,
  integer,
  decimal,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Content-capture (Plan 4B)
  contentCaptureEnabled: boolean("content_capture_enabled")
    .notNull()
    .default(false),
  contentCaptureEnabledAt: timestamp("content_capture_enabled_at", {
    withTimezone: true,
  }),
  contentCaptureEnabledBy: uuid("content_capture_enabled_by"),
  retentionDaysOverride: integer("retention_days_override"),
  llmEvalEnabled: boolean("llm_eval_enabled").notNull().default(false),
  llmEvalAccountId: uuid("llm_eval_account_id"),
  llmEvalModel: text("llm_eval_model"),
  captureThinking: boolean("capture_thinking").notNull().default(false),
  rubricId: uuid("rubric_id"),
  leaderboardEnabled: boolean("leaderboard_enabled").notNull().default(false),
  // Plan 4C — cost budget + facet
  llmFacetEnabled: boolean("llm_facet_enabled").notNull().default(false),
  llmFacetModel: text("llm_facet_model"),
  llmMonthlyBudgetUsd: decimal("llm_monthly_budget_usd", {
    precision: 10,
    scale: 2,
  }),
  llmBudgetOverageBehavior: text("llm_budget_overage_behavior")
    .notNull()
    .default("degrade"),
  llmHaltedUntilMonthEnd: boolean("llm_halted_until_month_end")
    .notNull()
    .default(false),
  // When the halt flag was set (UTC). NULL when halt is off.
  // Used by enforceBudget to detect month rollover and auto-clear stale halts.
  llmHaltedAt: timestamp("llm_halted_at", { withTimezone: true }),
  // Resident telemetry agent poll interval override, in seconds.
  // NULL = use the server default (60s).
  agentPollIntervalSeconds: integer("agent_poll_interval_seconds"),
});

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    uniqOrgSlug: unique("departments_org_slug_unique").on(t.orgId, t.slug),
  }),
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    parentTeamId: uuid("parent_team_id").references(
      (): AnyPgColumn => teams.id,
      {
        onDelete: "set null",
      },
    ),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({ uniqOrgSlug: unique("teams_org_slug_unique").on(t.orgId, t.slug) }),
);
