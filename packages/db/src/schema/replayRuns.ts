import { pgTable, text, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";
import { usageLogs } from "./usageLogs.js";

/**
 * 單筆重放的一次執行。`triggered_by` 是真正的 attribution——重放本身以 org
 * eval key 認證，usage_logs 會掛在那把系統金鑰上而非按下按鈕的人身上。
 */
export const replayRuns = pgTable(
  "replay_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceRequestId: text("source_request_id")
      .notNull()
      .references(() => usageLogs.requestId, { onDelete: "cascade" }),
    // 重放產生的 usage_logs.request_id；失敗時維持 null。
    replayRequestId: text("replay_request_id"),
    targetModel: text("target_model").notNull(),
    triggeredBy: uuid("triggered_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // queued | running | ok | failed
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    fidelity: jsonb("fidelity"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    orgTimeIdx: index("replay_runs_org_time_idx").on(t.orgId, t.createdAt),
    sourceIdx: index("replay_runs_source_idx").on(t.sourceRequestId),
  }),
);
