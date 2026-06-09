import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env";

// The plan's verbatim test used `serverEnvSchema.parse({})`, but the schema has
// required-no-default fields (NODE_ENV/DATABASE_URL/AUTH_SECRET/...) plus a
// superRefine that demands at least one OAuth provider — so `parse({})` throws.
// Mirror the baseline `valid` fixture from env.test.ts and go through
// `parseServerEnv` instead.
const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "a".repeat(32),
  NEXTAUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "g-id",
  GOOGLE_CLIENT_SECRET: "g-secret",
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com",
  BOOTSTRAP_DEFAULT_ORG_SLUG: "demo",
  BOOTSTRAP_DEFAULT_ORG_NAME: "Demo Org",
};

describe("serverEnv anthropic oauth", () => {
  it("defaults ENABLE_ANTHROPIC_OAUTH to false and oauth urls to undefined", () => {
    const env = parseServerEnv(valid);
    expect(env.ENABLE_ANTHROPIC_OAUTH).toBe(false);
    expect(env.ANTHROPIC_OAUTH_AUTHORIZE_URL).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_TOKEN_URL).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_REDIRECT_URI).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_SCOPES).toBeUndefined();
  });

  it("parses ENABLE_ANTHROPIC_OAUTH='true' as boolean true", () => {
    const env = parseServerEnv({ ...valid, ENABLE_ANTHROPIC_OAUTH: "true" });
    expect(env.ENABLE_ANTHROPIC_OAUTH).toBe(true);
  });
});
