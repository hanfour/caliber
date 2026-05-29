import {
  pgTable,
  uuid,
  customType,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { upstreamAccounts } from "./accounts.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const credentialVault = pgTable(
  "credential_vault",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .unique()
      .references(() => upstreamAccounts.id, { onDelete: "cascade" }),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => ({
    oauthExpiryIdx: index("credential_vault_oauth_expiry_idx")
      .on(t.oauthExpiresAt)
      .where(sql`${t.oauthExpiresAt} IS NOT NULL`),
  }),
);
