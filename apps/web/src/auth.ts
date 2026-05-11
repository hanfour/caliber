import NextAuth, { type NextAuthConfig, type NextAuthResult } from "next-auth";
import { createDb } from "@caliber/db";
import { buildAuthConfig } from "@caliber/auth";
import { getEnv } from "./env.js";

type DbHandle = ReturnType<typeof createDb>;

let cachedDb: DbHandle | null = null;

function resolveAuthConfig(): NextAuthConfig {
  const env = getEnv();
  if (!cachedDb) cachedDb = createDb(env.DATABASE_URL);
  return buildAuthConfig(cachedDb.db, {
    AUTH_SECRET: env.AUTH_SECRET,
    AUTH_TRUST_HOST: env.AUTH_TRUST_HOST,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    superAdminEmail: env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
    defaultOrgSlug: env.BOOTSTRAP_DEFAULT_ORG_SLUG,
    defaultOrgName: env.BOOTSTRAP_DEFAULT_ORG_NAME,
  });
}

const result: NextAuthResult = NextAuth(resolveAuthConfig);

export const handlers: NextAuthResult["handlers"] = result.handlers;
export const auth: NextAuthResult["auth"] = result.auth;
export const signIn: NextAuthResult["signIn"] = result.signIn;
export const signOut: NextAuthResult["signOut"] = result.signOut;

export const { GET, POST } = handlers;
