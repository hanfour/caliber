import {
  pgTable,
  uuid,
  text,
  integer,
  bigserial,
  timestamp,
  decimal,
  boolean,
  inet,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { organizations, teams } from "./org.js";
import { apiKeys } from "./apiKeys.js";
import { upstreamAccounts } from "./accounts.js";
import { accountGroups } from "./accountGroups.js";
import { devices } from "./devices.js";

export const usageLogs = pgTable(
  "usage_logs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    requestId: text("request_id").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "restrict" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => upstreamAccounts.id, { onDelete: "restrict" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    requestedModel: text("requested_model").notNull(),
    upstreamModel: text("upstream_model").notNull(),
    platform: text("platform").notNull(),
    surface: text("surface").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    // Plan 5A — Anthropic prompt-cache TTL split.  cache_creation_tokens
    // remains the aggregate (5m + 1h) for backwards compat with 4A consumers;
    // these two columns track the per-tier breakdown when the upstream
    // response exposes it.  Always 0 for OpenAI rows.
    cacheCreation5mTokens: integer("cache_creation_5m_tokens")
      .notNull()
      .default(0),
    cacheCreation1hTokens: integer("cache_creation_1h_tokens")
      .notNull()
      .default(0),
    // Plan 5A — OpenAI cached_input.  Always 0 for Anthropic rows.
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    inputCost: decimal("input_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    outputCost: decimal("output_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    cacheCreationCost: decimal("cache_creation_cost", {
      precision: 20,
      scale: 10,
    })
      .notNull()
      .default("0"),
    cacheReadCost: decimal("cache_read_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    // Plan 5A — OpenAI cached_input cost; tracked separately so reports can
    // distinguish discounted-input billing from regular input + the Anthropic
    // cache_read_cost path.  Always 0 for Anthropic rows.
    cachedInputCost: decimal("cached_input_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    totalCost: decimal("total_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    // Plan 5A — second-stage billing per design §11.3 / X8: total_cost is
    // the raw provider cost (or 0 for OAuth subscription rows); actual_cost
    // = total_cost × group rate_multiplier × account rate_multiplier.  This
    // is the value group-level dashboards charge against budgets.  Precision
    // matches `total_cost` (numeric(20, 10)) so multiplier-applied values
    // never lose precision relative to the raw cost.
    actualCostUsd: decimal("actual_cost_usd", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    rateMultiplier: decimal("rate_multiplier", { precision: 10, scale: 4 })
      .notNull()
      .default("1.0"),
    accountRateMultiplier: decimal("account_rate_multiplier", {
      precision: 10,
      scale: 4,
    })
      .notNull()
      .default("1.0"),
    // Plan 5A — group routing trail.  NULL on legacy 4A/4C rows; populated by
    // the gateway once the api-key → group binding (PR #31) is exercised.
    // ON DELETE SET NULL preserves historical rows when an admin removes a
    // group.
    groupId: uuid("group_id").references(() => accountGroups.id, {
      onDelete: "set null",
    }),
    stream: boolean("stream").notNull().default(false),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    firstTokenMs: integer("first_token_ms"),
    bufferReleasedAtMs: integer("buffer_released_at_ms"),
    upstreamRetries: integer("upstream_retries").notNull().default(0),
    failedAccountIds: uuid("failed_account_ids").array(),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
    // Phase 1 multi-source ingest: ak_* tokens bound to a device populate this;
    // legacy tokens leave it NULL. Evaluator_events view joins through this.
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("usage_logs_user_time_idx").on(t.userId, t.createdAt),
    apiKeyTimeIdx: index("usage_logs_api_key_time_idx").on(
      t.apiKeyId,
      t.createdAt,
    ),
    accountTimeIdx: index("usage_logs_account_time_idx").on(
      t.accountId,
      t.createdAt,
    ),
    orgTimeIdx: index("usage_logs_org_time_idx").on(t.orgId, t.createdAt),
    teamTimeIdx: index("usage_logs_team_time_idx").on(t.teamId, t.createdAt),
    modelIdx: index("usage_logs_model_idx").on(t.requestedModel),
    groupTimeIdx: index("usage_logs_group_time_idx").on(t.groupId, t.createdAt),
  }),
);
