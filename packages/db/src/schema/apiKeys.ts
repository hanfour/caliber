import {
  pgTable,
  uuid,
  text,
  timestamp,
  decimal,
  boolean,
  inet,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { organizations, teams } from "./org.js";
import { accountGroups } from "./accountGroups.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    groupId: uuid("group_id").references(() => accountGroups.id, {
      onDelete: "set null",
    }),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    routingPolicy: text("routing_policy").notNull().default("pool"),
    ipWhitelist: text("ip_whitelist").array(),
    ipBlacklist: text("ip_blacklist").array(),
    quotaUsd: decimal("quota_usd", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    quotaUsedUsd: decimal("quota_used_usd", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    rateLimit1dUsd: decimal("rate_limit_1d_usd", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revealTokenHash: text("reveal_token_hash"),
    revealTokenExpiresAt: timestamp("reveal_token_expires_at", {
      withTimezone: true,
    }),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    revealedByIp: inet("revealed_by_ip"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    evaluateAsProject: boolean("evaluate_as_project").notNull().default(false),
  },
  (t) => ({
    userIdx: index("api_keys_user_idx")
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
    orgIdx: index("api_keys_org_idx")
      .on(t.orgId)
      .where(sql`${t.revokedAt} IS NULL`),
    revealIdx: index("api_keys_reveal_idx")
      .on(t.revealTokenHash)
      .where(sql`${t.revealTokenHash} IS NOT NULL`),
    groupIdx: index("api_keys_group_idx")
      .on(t.groupId)
      .where(sql`${t.revokedAt} IS NULL AND ${t.groupId} IS NOT NULL`),
    evalProjectIdx: index("api_keys_eval_project_idx")
      .on(t.orgId)
      .where(
        sql`${t.evaluateAsProject} = true AND ${t.revokedAt} IS NULL`,
      ),
    routingPolicyValues: check(
      "api_keys_routing_policy_values",
      sql`${t.routingPolicy} IN ('pool','own','own_then_pool')`,
    ),
    routingPolicyGroupMutex: check(
      "api_keys_routing_policy_group_mutex",
      sql`${t.routingPolicy} = 'pool' OR ${t.groupId} IS NULL`,
    ),
  }),
);
