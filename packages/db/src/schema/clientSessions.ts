import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { organizations } from "./org.js";
import { devices } from "./devices.js";

export const clientSessions = pgTable(
  "client_sessions",
  {
    id: text("id").primaryKey(),
    parentSessionId: text("parent_session_id").references(
      (): AnyPgColumn => clientSessions.id,
      { onDelete: "set null" },
    ),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceClient: text("source_client").notNull(),
    cwd: text("cwd"),
    gitCommitHash: text("git_commit_hash"),
    gitBranch: text("git_branch"),
    gitRemoteUrl: text("git_remote_url"),
    cliVersion: text("cli_version"),
    modelProvider: text("model_provider"),
    baseInstructionsHash: text("base_instructions_hash"),
    baseInstructionsText: text("base_instructions_text"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgUserIdx: index("client_sessions_org_user_idx").on(t.orgId, t.userId),
    deviceIdx: index("client_sessions_device_idx").on(t.deviceId),
    parentIdx: index("client_sessions_parent_idx").on(t.parentSessionId),
  }),
);
