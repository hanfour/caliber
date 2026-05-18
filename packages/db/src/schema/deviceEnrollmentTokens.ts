import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { organizations } from "./org.js";
import { devices } from "./devices.js";

export const deviceEnrollmentTokens = pgTable(
  "device_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByDeviceId: uuid("used_by_device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresIdx: index("device_enrollment_tokens_expires_idx").on(t.expiresAt),
  }),
);
