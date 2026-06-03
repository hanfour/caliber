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

    it("API_TRPC_RPM_LIMIT defaults to 2000 and accepts 0 (disable)", () => {
      expect(parseServerEnv({ ...valid }).API_TRPC_RPM_LIMIT).toBe(2000);
      expect(
        parseServerEnv({ ...valid, API_TRPC_RPM_LIMIT: "0" }).API_TRPC_RPM_LIMIT,
      ).toBe(0);
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

    it("GATEWAY_MAX_WAIT defaults to 10 and accepts 0 to disable admission", () => {
      expect(parseServerEnv({ ...valid }).GATEWAY_MAX_WAIT).toBe(10);
      expect(parseServerEnv({ ...valid, GATEWAY_MAX_WAIT: "" }).GATEWAY_MAX_WAIT).toBe(10);
      expect(parseServerEnv({ ...valid, GATEWAY_MAX_WAIT: "0" }).GATEWAY_MAX_WAIT).toBe(0);
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

  // ── OAuth provider optionality ─────────────────────────────────────────────
  // PR fix-mode1: each pair is independently optional, but at least one must
  // be configured. Empty strings are treated as unset (compose interpolation).

  describe("OAuth provider optionality", () => {
    it("accepts GitHub-only (Google blank)", () => {
      const env = parseServerEnv({
        ...valid,
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
      });
      expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
      expect(env.GITHUB_CLIENT_ID).toBe("gh-id");
    });

    it("accepts Google-only (GitHub blank)", () => {
      const env = parseServerEnv({
        ...valid,
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
      });
      expect(env.GITHUB_CLIENT_ID).toBeUndefined();
      expect(env.GOOGLE_CLIENT_ID).toBe("g-id");
    });

    it("rejects when both providers are blank (sign-in would be dead)", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: "",
        }),
      ).toThrow(/At least one OAuth provider/);
    });

    // Half-set pairs are a common typo: copy GOOGLE_CLIENT_ID, forget the
    // secret. Without an explicit reject, buildProviders silently drops the
    // half-set provider and the operator gets a missing sign-in button with
    // no boot-time signal.

    it("rejects half-set Google pair (id without secret)", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          GOOGLE_CLIENT_ID: "g-id",
          GOOGLE_CLIENT_SECRET: "",
        }),
      ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/);
    });

    it("rejects half-set Google pair (secret without id)", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "g-secret",
        }),
      ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/);
    });

    it("rejects half-set GitHub pair (id without secret)", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          GITHUB_CLIENT_ID: "gh-id",
          GITHUB_CLIENT_SECRET: "",
        }),
      ).toThrow(/GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together/);
    });

    it("accepts half-set Google + valid GitHub doesn't help — half-set still rejects", () => {
      // Even with GitHub valid, the half-set Google is still a config error
      // worth surfacing; we don't want to silently drop the typo.
      expect(() =>
        parseServerEnv({
          ...valid,
          GOOGLE_CLIENT_ID: "g-id",
          GOOGLE_CLIENT_SECRET: "",
        }),
      ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/);
    });
  });

  // ── AUTH_TRUST_HOST default ────────────────────────────────────────────────
  // Auth.js v5 defaults trustHost=false in production, which rejects every
  // request on self-hosted compose deploys. We default to true so the typical
  // operator path "just works"; opt-out is still possible.

  describe("AUTH_TRUST_HOST", () => {
    it("defaults to true when unset", () => {
      const env = parseServerEnv(valid);
      expect(env.AUTH_TRUST_HOST).toBe(true);
    });

    it('honours explicit "false"', () => {
      const env = parseServerEnv({ ...valid, AUTH_TRUST_HOST: "false" });
      expect(env.AUTH_TRUST_HOST).toBe(false);
    });
  });
});
