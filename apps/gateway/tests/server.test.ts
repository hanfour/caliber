import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { buildServer } from "../src/server.js";
import { parseServerEnv, type ServerEnv } from "@caliber/config";

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

function makeEnv(overrides: Record<string, string> = {}): ServerEnv {
  return parseServerEnv({ ...validBase, ...overrides });
}

describe("gateway server", () => {
  it("responds 200 on /health", async () => {
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: {} as never,
      redis: new RedisMock() as unknown as Redis,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns {status:"disabled"} when ENABLE_GATEWAY=false', async () => {
    const app = await buildServer({ env: makeEnv() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "disabled" });
    await app.close();
  });

  it("fail-fast: parseServerEnv throws when ENABLE_GATEWAY=true but required gateway vars are missing", () => {
    expect(() =>
      parseServerEnv({ ...validBase, ENABLE_GATEWAY: "true" }),
    ).toThrow();
  });

  it("requests to non-public paths require an API key (apiKeyAuthPlugin is wired)", async () => {
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: {} as never,
      redis: new RedisMock() as unknown as Redis,
    });
    app.get("/v1/test", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "missing_api_key" });
    await app.close();
  });

  it("/metrics on the public listener requires auth (moved to private listener)", async () => {
    // Audit 2026-05-20 finding #5: /metrics relocated to a private
    // listener bound to METRICS_HOST:METRICS_PORT (default 127.0.0.1:9464).
    // Public listener now 401s unauthenticated metric scrape attempts.
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: {} as never,
      redis: new RedisMock() as unknown as Redis,
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("decorates fastify.db when enabled", async () => {
    const fakeDb = { sentinel: true } as never;
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: fakeDb,
      redis: new RedisMock() as unknown as Redis,
    });
    expect(app.db).toBe(fakeDb);
    await app.close();
  });

  it("does NOT register apiKeyAuthPlugin when disabled (no db open)", async () => {
    const app = await buildServer({ env: makeEnv() });
    expect(app.hasDecorator("db")).toBe(false);
    const res = await app.inject({ method: "GET", url: "/v1/anything" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("skips BullMQ wiring when opts.redis is injected (test mode)", async () => {
    // Inject ioredis-mock so the buildServer escape hatch fires; verifies
    // fastify.usageLogQueue stays undefined and route-level code that doesn't
    // touch the queue can run without standing up real BullMQ infra.
    const mockRedis = new RedisMock() as unknown as Redis;
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: {} as never,
      redis: mockRedis,
    });
    expect(app.usageLogQueue).toBeUndefined();
    expect(app.hasDecorator("usageLogQueue")).toBe(false);
    await app.close();
  });

  // NOTE: The "production wiring decorates fastify.usageLogQueue" assertion
  // lives in tests/server.integration.test.ts — it requires a real Redis
  // because `new Worker(...)` opens a live ioredis connection at construction
  // time and would hang in CI without it. Keeping that case unit-side caused
  // a hidden localhost:6379 dependency.

  it("app.close() is idempotent / does not throw when BullMQ wiring is skipped", async () => {
    // Regression guard: the onClose hook only fires when wireUsageLogPipeline()
    // ran, so the test-mode path (opts.redis injected) must close cleanly with
    // no orphaned BullMQ resources.
    const mockRedis = new RedisMock() as unknown as Redis;
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
      db: {} as never,
      redis: mockRedis,
    });
    await expect(app.close()).resolves.not.toThrow();
  });
});
