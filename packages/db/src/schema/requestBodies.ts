import { pgTable, text, uuid, jsonb, customType, boolean, timestamp, smallint, index } from 'drizzle-orm/pg-core'
import { organizations } from './org.js'
import { usageLogs } from './usageLogs.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const requestBodies = pgTable('request_bodies', {
  requestId: text('request_id').primaryKey().references(() => usageLogs.requestId, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  requestBodySealed: bytea('request_body_sealed').notNull(),
  responseBodySealed: bytea('response_body_sealed').notNull(),
  thinkingBodySealed: bytea('thinking_body_sealed'),
  attemptErrorsSealed: bytea('attempt_errors_sealed'),
  cipherVersion: smallint('cipher_version').notNull().default(1),
  requestParams: jsonb('request_params'),
  stopReason: text('stop_reason'),
  clientUserAgent: text('client_user_agent'),
  clientSessionId: text('client_session_id'),
  attachmentsMeta: jsonb('attachments_meta'),
  cacheControlMarkers: jsonb('cache_control_markers'),
  toolResultTruncated: boolean('tool_result_truncated').notNull().default(false),
  bodyTruncated: boolean('body_truncated').notNull().default(false),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
}, (t) => ({
  retentionIdx: index('request_bodies_retention_idx').on(t.retentionUntil),
  orgTimeIdx: index('request_bodies_org_time_idx').on(t.orgId, t.capturedAt),
}))
