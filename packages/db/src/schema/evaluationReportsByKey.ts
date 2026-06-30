import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  decimal,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { organizations, teams } from './org.js'
import { users } from './auth.js'
import { rubrics } from './rubrics.js'
import { upstreamAccounts } from './accounts.js'
import { apiKeys } from './apiKeys.js'

/**
 * Shared scoring columns reused by both `evaluationReports` and
 * `evaluationReportsByKey`. Exported so that a schema-parity test can assert
 * neither table drifts from the shared contract.
 *
 * Usage:
 *   const myTable = pgTable('my_table', {
 *     id: uuid('id').primaryKey().defaultRandom(),
 *     ...evaluationReportScoreColumns(organizations, users, teams, rubrics, upstreamAccounts),
 *     // table-specific extras ...
 *   })
 *
 * We expose these as a plain record of Drizzle column builders so both tables
 * share the same construction logic without any runtime overhead.
 */
export const evaluationReportScoreColumns = {
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
  llmUpstreamAccountId: uuid('llm_upstream_account_id').references(
    () => upstreamAccounts.id,
    { onDelete: 'set null' },
  ),
  triggeredBy: text('triggered_by').notNull(),
  triggeredByUser: uuid('triggered_by_user').references(() => users.id, {
    onDelete: 'set null',
  }),
  sourceBreakdown: jsonb('source_breakdown'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
} as const

/**
 * Per-api-key evaluation reports table.
 *
 * Structurally mirrors `evaluation_reports` (same scoring columns, same FK
 * semantics) but keyed by api_key_id rather than just (userId, period). This
 * keeps the per-person path byte-identical — we only ADD this table; the
 * existing `evaluation_reports` table and all its queries are untouched.
 */
export const evaluationReportsByKey = pgTable(
  'evaluation_reports_by_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...evaluationReportScoreColumns,
    // Per-key extras
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    keyNameSnapshot: text('key_name_snapshot').notNull(),
  },
  (t) => ({
    uniqByKey: uniqueIndex('evaluation_reports_by_key_uniq').on(
      t.userId,
      t.apiKeyId,
      t.periodStart,
      t.periodType,
    ),
    apiKeyTimeIdx: index('erbk_api_key_time_idx').on(t.apiKeyId, t.periodStart),
    orgTimeIdx: index('erbk_org_time_idx').on(t.orgId, t.periodStart),
    userTimeIdx: index('erbk_user_time_idx').on(t.userId, t.periodStart),
    teamTimeIdx: index('erbk_team_time_idx').on(t.teamId, t.periodStart),
  }),
)
