import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { devices } from "./devices.js";
import { clientSessions } from "./clientSessions.js";

// Physical table is RANGE-partitioned by ingested_at (monthly) in migration
// 0013 — drizzle does not model PARTITION BY but inserts route transparently.
// PK and UNIQUE include ingested_at because postgres requires partition-key
// columns to be part of every uniqueness constraint on a partitioned table.
// Cross-partition dedup (daemon paused > 1 month then retries) is handled at
// the evaluator layer; in-partition retries are caught by the UNIQUE
// constraint on the common ~60s daemon flush cadence.
export const clientEvents = pgTable(
  "client_events",
  {
    id: uuid("id").notNull().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => clientSessions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    parentEventId: text("parent_event_id"),
    turnId: text("turn_id"),
    role: text("role"),
    eventType: text("event_type").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    content: jsonb("content"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    source: text("source").notNull().default("transcript"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.ingestedAt] }),
    dedup: unique("client_events_dedup_key").on(
      t.sessionId,
      t.eventId,
      t.source,
      t.ingestedAt,
    ),
    sessionTsIdx: index("client_events_session_ts").on(
      t.sessionId,
      t.timestamp,
    ),
    orgTsIdx: index("client_events_org_ts").on(t.orgId, t.timestamp),
  }),
);
