import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  customType,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Org-level GitHub connection (PR1, spec 2026-07-15).
 * One fine-grained PAT per org, sealed with AES-256-GCM/HKDF
 * (salt = this row's id — re-encryption on update MUST reuse the row id).
 * The token is write-only: no API path ever returns it.
 */
export const githubConnections = pgTable(
  "github_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // GitHub org (or user) the PAT is scoped to; drives repo listing.
    ownerLogin: text("owner_login").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    tokenLast4: text("token_last4").notNull(),
    // string[] of "owner/repo"; NULL = all repos the PAT can see.
    repoAllowlist: jsonb("repo_allowlist"),
    deliveryEnabled: boolean("delivery_enabled").notNull().default(true),
    // 'ok' | 'auth_error' | 'rate_limited' | 'sync_error'
    status: text("status").notNull().default("ok"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Per-repo, per-resource incremental sync watermark.
 * resourceType: 'pulls' | 'issues' | 'projects' (projects uses
 * repoFullName = '*' — it is org-scoped, not repo-scoped).
 */
export const githubSyncState = pgTable(
  "github_sync_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    resourceType: text("resource_type").notNull(),
    watermark: timestamp("watermark", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgRepoResourceUniq: uniqueIndex(
      "github_sync_state_org_repo_resource_uniq",
    ).on(t.orgId, t.repoFullName, t.resourceType),
  }),
);
