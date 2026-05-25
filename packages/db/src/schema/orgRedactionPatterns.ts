import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

export const orgRedactionPatterns = pgTable("org_redaction_patterns", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  patterns: jsonb("patterns").$type<RedactionPattern[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RedactionPattern = {
  name: string;
  regex: string;
  replacement: string;
};
