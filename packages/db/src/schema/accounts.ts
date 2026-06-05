import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  decimal,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, teams } from "./org.js";
import { users } from "./auth.js";

export const upstreamAccounts = pgTable(
  "upstream_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    notes: text("notes"),
    platform: text("platform").notNull(),
    type: text("type").notNull(),
    schedulable: boolean("schedulable").notNull().default(true),
    priority: integer("priority").notNull().default(50),
    concurrency: integer("concurrency").notNull().default(3),
    rateMultiplier: decimal("rate_multiplier", { precision: 10, scale: 4 })
      .notNull()
      .default("1.0"),
    rateLimitedAt: timestamp("rate_limited_at", { withTimezone: true }),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),
    overloadUntil: timestamp("overload_until", { withTimezone: true }),
    tempUnschedulableUntil: timestamp("temp_unschedulable_until", {
      withTimezone: true,
    }),
    tempUnschedulableReason: text("temp_unschedulable_reason"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    oauthRefreshFailCount: integer("oauth_refresh_fail_count")
      .notNull()
      .default(0),
    oauthRefreshLastError: text("oauth_refresh_last_error"),
    oauthRefreshLastRunAt: timestamp("oauth_refresh_last_run_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    autoPauseOnExpired: boolean("auto_pause_on_expired")
      .notNull()
      .default(true),
    status: text("status").notNull().default("active"),
    errorMessage: text("error_message"),
    subscriptionTier: text("subscription_tier"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    scopeIdx: index("upstream_accounts_scope_idx")
      .on(t.orgId, t.teamId)
      .where(sql`${t.deletedAt} IS NULL`),
    selectIdx: index("upstream_accounts_select_idx")
      .on(t.orgId, t.teamId, t.priority)
      .where(sql`${t.deletedAt} IS NULL AND ${t.schedulable} = true`),
    userSelectIdx: index("upstream_accounts_user_select_idx")
      .on(t.orgId, t.userId, t.platform, t.priority)
      .where(sql`${t.deletedAt} IS NULL AND ${t.schedulable} = true`),
    userXorTeam: check(
      "upstream_accounts_user_id_xor_team_id",
      sql`${t.userId} IS NULL OR ${t.teamId} IS NULL`,
    ),
  }),
);
