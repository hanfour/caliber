import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./org.js";
import { users } from "./auth.js";
import { apiKeys } from "./apiKeys.js";

export const rubrics = pgTable(
  "rubrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    version: text("version").notNull(),
    definition: jsonb("definition").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "cascade",
    }),
  },
  (t) => ({
    orgIdx: index("rubrics_org_idx")
      .on(t.orgId)
      .where(sql`${t.deletedAt} IS NULL`),
    defaultIdx: index("rubrics_default_idx")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = true`),
    apiKeyUniq: uniqueIndex("rubrics_api_key_uniq")
      .on(t.apiKeyId)
      .where(sql`api_key_id IS NOT NULL AND deleted_at IS NULL`),
    keyScopeChk: check(
      "rubrics_key_scope_chk",
      sql`api_key_id IS NULL OR (org_id IS NOT NULL AND is_default = false)`,
    ),
  }),
);
