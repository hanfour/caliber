import { DrizzleAdapter } from "@auth/drizzle-adapter";
import type { Adapter } from "next-auth/adapters";
import type { Database } from "@caliber/db";
import { users, accounts, sessions, verificationTokens } from "@caliber/db";

export function makeAdapter(db: Database): Adapter {
  return DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });
}
