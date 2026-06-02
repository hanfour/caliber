import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env";

const VALID_HEX_64 = "a".repeat(64);
const VALID_PEPPER = "b".repeat(64);

const validBase = {
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
} as const;

const validGateway = {
  ...validBase,
  ENABLE_GATEWAY: "true",
  GATEWAY_BASE_URL: "http://localhost:3002",
  REDIS_URL: "redis://localhost:6379",
  CREDENTIAL_ENCRYPTION_KEY: VALID_HEX_64,
  API_KEY_HASH_PEPPER: VALID_PEPPER,
} as const;

describe("parseServerEnv — gateway vars", () => {
  // 1. Default behaviour: ENABLE_GATEWAY=false (or absent) needs no gateway vars
  it("accepts ENABLE_GATEWAY=false with no gateway vars present", () => {
    const env = parseServerEnv(validBase);
    expect(env.ENABLE_GATEWAY).toBe(false);
  });

  // 2. Happy path: ENABLE_GATEWAY=true with all required vars + valid secrets
  it("accepts ENABLE_GATEWAY=true with all required gateway vars and valid hex secrets", () => {
    const env = parseServerEnv(validGateway);
    expect(env.ENABLE_GATEWAY).toBe(true);
    expect(env.GATEWAY_BASE_URL).toBe("http://localhost:3002");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBe(VALID_HEX_64);
    expect(env.API_KEY_HASH_PEPPER).toBe(VALID_PEPPER);
  });

  // 3. Rejects missing GATEWAY_BASE_URL when gateway enabled
  it("rejects ENABLE_GATEWAY=true with missing GATEWAY_BASE_URL", () => {
    const { GATEWAY_BASE_URL: _, ...rest } = validGateway;
    expect(() => parseServerEnv(rest)).toThrow(/GATEWAY_BASE_URL/);
  });

  // 4. Rejects missing REDIS_URL when gateway enabled
  it("rejects ENABLE_GATEWAY=true with missing REDIS_URL", () => {
    const { REDIS_URL: _, ...rest } = validGateway;
    expect(() => parseServerEnv(rest)).toThrow(/REDIS_URL/);
  });

  // 5. Rejects missing CREDENTIAL_ENCRYPTION_KEY when gateway enabled
  it("rejects ENABLE_GATEWAY=true with missing CREDENTIAL_ENCRYPTION_KEY", () => {
    const { CREDENTIAL_ENCRYPTION_KEY: _, ...rest } = validGateway;
    expect(() => parseServerEnv(rest)).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  // 6. Rejects missing API_KEY_HASH_PEPPER when gateway enabled
  it("rejects ENABLE_GATEWAY=true with missing API_KEY_HASH_PEPPER", () => {
    const { API_KEY_HASH_PEPPER: _, ...rest } = validGateway;
    expect(() => parseServerEnv(rest)).toThrow(/API_KEY_HASH_PEPPER/);
  });

  // 7. Rejects CREDENTIAL_ENCRYPTION_KEY of wrong length (63 chars) regardless of ENABLE_GATEWAY
  it("rejects CREDENTIAL_ENCRYPTION_KEY with wrong length (63 chars)", () => {
    expect(() =>
      parseServerEnv({
        ...validBase,
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(63),
      }),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  // 8. Rejects CREDENTIAL_ENCRYPTION_KEY with non-hex chars
  it("rejects CREDENTIAL_ENCRYPTION_KEY with non-hex chars", () => {
    expect(() =>
      parseServerEnv({
        ...validBase,
        CREDENTIAL_ENCRYPTION_KEY: "z".repeat(64),
      }),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  // 9. Rejects API_KEY_HASH_PEPPER of wrong length / non-hex
  it("rejects API_KEY_HASH_PEPPER of wrong length", () => {
    expect(() =>
      parseServerEnv({ ...validBase, API_KEY_HASH_PEPPER: "b".repeat(63) }),
    ).toThrow(/API_KEY_HASH_PEPPER/);
  });

  it("rejects API_KEY_HASH_PEPPER with non-hex chars", () => {
    expect(() =>
      parseServerEnv({ ...validBase, API_KEY_HASH_PEPPER: "z".repeat(64) }),
    ).toThrow(/API_KEY_HASH_PEPPER/);
  });

  // 10. Coerces GATEWAY_PORT string to number
  it('accepts GATEWAY_PORT="5000" string and coerces to number 5000', () => {
    const env = parseServerEnv({ ...validBase, GATEWAY_PORT: "5000" });
    expect(env.GATEWAY_PORT).toBe(5000);
  });

  // 11. Defaults GATEWAY_REDIS_FAILURE_MODE to "strict"
  it('defaults GATEWAY_REDIS_FAILURE_MODE to "strict"', () => {
    const env = parseServerEnv(validBase);
    expect(env.GATEWAY_REDIS_FAILURE_MODE).toBe("strict");
  });

  // 12. Rejects GATEWAY_REDIS_FAILURE_MODE="banana"
  it('rejects GATEWAY_REDIS_FAILURE_MODE="banana"', () => {
    expect(() =>
      parseServerEnv({ ...validBase, GATEWAY_REDIS_FAILURE_MODE: "banana" }),
    ).toThrow();
  });

  // 13. Defaults UPSTREAM_ANTHROPIC_BASE_URL
  it('defaults UPSTREAM_ANTHROPIC_BASE_URL to "https://api.anthropic.com"', () => {
    const env = parseServerEnv(validBase);
    expect(env.UPSTREAM_ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  // 13b. Defaults UPSTREAM_OPENAI_BASE_URL (Plan 5A PR 9d)
  it('defaults UPSTREAM_OPENAI_BASE_URL to "https://api.openai.com"', () => {
    const env = parseServerEnv(validBase);
    expect(env.UPSTREAM_OPENAI_BASE_URL).toBe("https://api.openai.com");
  });

  // 14. Accepts ENABLE_GATEWAY="true" string (coerced to boolean true)
  it('accepts ENABLE_GATEWAY="true" string and coerces to boolean true', () => {
    const env = parseServerEnv(validGateway);
    expect(env.ENABLE_GATEWAY).toBe(true);
  });

  // 15. Rejects GATEWAY_PORT > 65535
  it("rejects GATEWAY_PORT > 65535", () => {
    expect(() =>
      parseServerEnv({ ...validBase, GATEWAY_PORT: "99999" }),
    ).toThrow(/GATEWAY_PORT/);
  });

  // 16. Defense-in-depth: format errors fire even when ENABLE_GATEWAY=false
  it("rejects bad CREDENTIAL_ENCRYPTION_KEY format even when ENABLE_GATEWAY=false (defense in depth)", () => {
    expect(() =>
      parseServerEnv({
        ...validBase,
        ENABLE_GATEWAY: "false",
        CREDENTIAL_ENCRYPTION_KEY: "z".repeat(64),
      }),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("rejects bad API_KEY_HASH_PEPPER format even when ENABLE_GATEWAY=false (defense in depth)", () => {
    expect(() =>
      parseServerEnv({
        ...validBase,
        ENABLE_GATEWAY: "false",
        API_KEY_HASH_PEPPER: "z".repeat(64),
      }),
    ).toThrow(/API_KEY_HASH_PEPPER/);
  });

  // 17. GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC defaults to 3600
  it("defaults GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC to 3600", () => {
    const env = parseServerEnv(validBase);
    expect(env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC).toBe(3600);
  });

  // 18. GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC coerces "0" to 0
  it('accepts GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC="0" and coerces to 0', () => {
    const env = parseServerEnv({
      ...validBase,
      GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC: "0",
    });
    expect(env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC).toBe(0);
  });
});
