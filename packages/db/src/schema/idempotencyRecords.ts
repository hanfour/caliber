import {
  pgTable,
  text,
  uuid,
  integer,
  decimal,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";
import { apiKeys } from "./apiKeys.js";

// Plan 4A §4.5 — supplementary billing/refund record keyed by the client
// X-Request-Id, scoped to the api key (tenant boundary), retained ~1h.
// NOT the dedup mechanism (that is the Redis cache); usage_logs remains the
// authoritative permanent ledger. Composite PK so two callers can reuse the
// same X-Request-Id without colliding.
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    internalRequestId: text("internal_request_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedModel: text("requested_model").notNull(),
    surface: text("surface").notNull(),
    platform: text("platform").notNull(),
    statusCode: integer("status_code").notNull(),
    totalCost: decimal("total_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    actualCostUsd: decimal("actual_cost_usd", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyId, t.requestId] }),
    expiresAtIdx: index("idempotency_records_expires_at_idx").on(t.expiresAt),
    orgCreatedIdx: index("idempotency_records_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
  }),
);
