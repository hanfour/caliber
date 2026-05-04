import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env";

describe("parseServerEnv", () => {
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

  it("parses a complete env", () => {
    const env = parseServerEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ENABLE_SWAGGER).toBe(false);
  });

  it('ENABLE_FACET_EXTRACTION defaults to false and accepts string "true"', () => {
    const off = parseServerEnv(valid);
    expect(off.ENABLE_FACET_EXTRACTION).toBe(false);

    const on = parseServerEnv({ ...valid, ENABLE_FACET_EXTRACTION: "true" });
    expect(on.ENABLE_FACET_EXTRACTION).toBe(true);
  });

  it("rejects AUTH_SECRET shorter than 32 chars", () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: "short" })).toThrow();
  });

  it("rejects invalid DATABASE_URL", () => {
    expect(() =>
      parseServerEnv({ ...valid, DATABASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("rejects missing BOOTSTRAP_SUPER_ADMIN_EMAIL", () => {
    const { BOOTSTRAP_SUPER_ADMIN_EMAIL: _, ...rest } = valid;
    expect(() => parseServerEnv(rest)).toThrow();
  });

  // ── empty-string handling ──────────────────────────────────────────────────
  // docker-compose's `${VAR:-}` interpolates to "" when the operator hasn't
  // set the var. Without `emptyAsUndefined`, `Number("")` would coerce to 0
  // and bypass the schema-level default — silently changing behaviour or
  // crashing min(1) checks. These tests pin the behaviour.

  describe("empty-string passthrough (compose ${VAR:-} unset case)", () => {
    it("GATEWAY_APIKEY_RPM_LIMIT='' falls back to 600 (default)", () => {
      const env = parseServerEnv({ ...valid, GATEWAY_APIKEY_RPM_LIMIT: "" });
      expect(env.GATEWAY_APIKEY_RPM_LIMIT).toBe(600);
    });

    it("GATEWAY_CACHE_TTL_SEC='' falls back to 0 (disabled)", () => {
      const env = parseServerEnv({ ...valid, GATEWAY_CACHE_TTL_SEC: "" });
      expect(env.GATEWAY_CACHE_TTL_SEC).toBe(0);
    });

    it("GATEWAY_MAX_ACCOUNT_SWITCHES='' falls back to 10 (would crash min(1) without fix)", () => {
      const env = parseServerEnv({
        ...valid,
        GATEWAY_MAX_ACCOUNT_SWITCHES: "",
      });
      expect(env.GATEWAY_MAX_ACCOUNT_SWITCHES).toBe(10);
    });

    it("GATEWAY_OAUTH_MAX_FAIL='' falls back to 3 (would crash min(1) without fix)", () => {
      const env = parseServerEnv({ ...valid, GATEWAY_OAUTH_MAX_FAIL: "" });
      expect(env.GATEWAY_OAUTH_MAX_FAIL).toBe(3);
    });

    it("GATEWAY_REDIS_FAILURE_MODE='' falls back to 'strict' (would crash enum without fix)", () => {
      const env = parseServerEnv({
        ...valid,
        GATEWAY_REDIS_FAILURE_MODE: "",
      });
      expect(env.GATEWAY_REDIS_FAILURE_MODE).toBe("strict");
    });

    it("UPSTREAM_OPENAI_BASE_URL='' falls back to api.openai.com (would crash url() without fix)", () => {
      const env = parseServerEnv({ ...valid, UPSTREAM_OPENAI_BASE_URL: "" });
      expect(env.UPSTREAM_OPENAI_BASE_URL).toBe("https://api.openai.com");
    });

    it("explicit values still take effect (default is only for missing/empty)", () => {
      const env = parseServerEnv({
        ...valid,
        GATEWAY_APIKEY_RPM_LIMIT: "120",
        GATEWAY_CACHE_TTL_SEC: "300",
      });
      expect(env.GATEWAY_APIKEY_RPM_LIMIT).toBe(120);
      expect(env.GATEWAY_CACHE_TTL_SEC).toBe(300);
    });

    it("explicit '0' is preserved (zero is a meaningful value, not empty)", () => {
      const env = parseServerEnv({
        ...valid,
        GATEWAY_APIKEY_RPM_LIMIT: "0",
      });
      expect(env.GATEWAY_APIKEY_RPM_LIMIT).toBe(0);
    });
  });
});
