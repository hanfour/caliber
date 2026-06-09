import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env";

// Baseline valid fixture — all required fields, no gateway extras
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

describe("serverEnv P4 connectivity", () => {
  it("defaults: tunnel/webhook undefined, throttle 10/300/900", () => {
    const env = parseServerEnv(valid);
    expect(env.TUNNEL_TOKEN).toBeUndefined();
    expect(env.GATEWAY_ALERT_WEBHOOK_URL).toBeUndefined();
    expect(env.GATEWAY_AUTH_FAIL_MAX).toBe(10);
    expect(env.GATEWAY_AUTH_FAIL_WINDOW_SEC).toBe(300);
    expect(env.GATEWAY_AUTH_FAIL_BLOCK_SEC).toBe(900);
  });
  it("parses overrides + rejects bad webhook url", () => {
    const env = parseServerEnv({
      ...valid,
      GATEWAY_AUTH_FAIL_MAX: "5",
      GATEWAY_ALERT_WEBHOOK_URL: "https://hooks.example/x",
    });
    expect(env.GATEWAY_AUTH_FAIL_MAX).toBe(5);
    expect(env.GATEWAY_ALERT_WEBHOOK_URL).toBe("https://hooks.example/x");
    expect(() =>
      parseServerEnv({ ...valid, GATEWAY_ALERT_WEBHOOK_URL: "not-a-url" }),
    ).toThrow();
  });
});
