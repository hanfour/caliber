import { pgTable, uuid, text, jsonb, timestamp, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { organizations, teams } from './org.js'
import { users } from './auth.js'
import { rubrics } from './rubrics.js'
import { upstreamAccounts } from './accounts.js'

export const evaluationReports = pgTable('evaluation_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  periodType: text('period_type').notNull(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'restrict' }),
  rubricVersion: text('rubric_version').notNull(),
  totalScore: decimal('total_score', { precision: 10, scale: 4 }).notNull(),
  sectionScores: jsonb('section_scores').notNull(),
  signalsSummary: jsonb('signals_summary').notNull(),
  dataQuality: jsonb('data_quality').notNull(),
  llmNarrative: text('llm_narrative'),
  llmEvidence: jsonb('llm_evidence'),
  llmModel: text('llm_model'),
  llmCalledAt: timestamp('llm_called_at', { withTimezone: true }),
  llmCostUsd: decimal('llm_cost_usd', { precision: 20, scale: 10 }),
  llmUpstreamAccountId: uuid('llm_upstream_account_id').references(() => upstreamAccounts.id, { onDelete: 'set null' }),
  triggeredBy: text('triggered_by').notNull(),
  triggeredByUser: uuid('triggered_by_user').references(() => users.id, { onDelete: 'set null' }),
  // Phase 1 (0014) — `{ "gateway_events": N, "transcript_events": M, "overlap": K }`.
  // Reviewers can see which path produced this report's data. NULL on legacy rows.
  sourceBreakdown: jsonb('source_breakdown'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userTimeIdx: index('evaluation_reports_user_time_idx').on(t.userId, t.periodStart),
  orgTimeIdx: index('evaluation_reports_org_time_idx').on(t.orgId, t.periodStart),
  teamTimeIdx: index('evaluation_reports_team_time_idx').on(t.teamId, t.periodStart),
  periodUniq: uniqueIndex('evaluation_reports_period_uniq').on(t.userId, t.periodStart, t.periodType),
}))
