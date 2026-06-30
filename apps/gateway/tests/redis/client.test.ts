import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import type { ServerEnv } from "@caliber/config";
import { redisPlugin } from "../../src/redis/client.js";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://u:p@localhost/db",
    AUTH_SECRET: "a".repeat(32),
    NEXTAUTH_URL: "http://localhost:3000",
    AUTH_TRUST_HOST: true,
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "g",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "a@b.com",
    BOOTSTRAP_DEFAULT_ORG_SLUG: "demo",
    BOOTSTRAP_DEFAULT_ORG_NAME: "Demo",
    ENABLE_SWAGGER: false,
    LOG_LEVEL: "info",
    ENABLE_TEST_SEED: false,
    ENABLE_GATEWAY: true,
    ENABLE_ANTHROPIC_OAUTH: false,
    GATEWAY_PORT: 3002,
    GATEWAY_BASE_URL: "http://localhost:3002",
    REDIS_URL: "redis://localhost:6379",
    CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
    API_KEY_HASH_PEPPER: "b".repeat(64),
    UPSTREAM_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    UPSTREAM_OPENAI_BASE_URL: "https://api.openai.com",
    GATEWAY_MAX_ACCOUNT_SWITCHES: 10,
    GATEWAY_MAX_WAIT: 10,
    GATEWAY_MAX_BODY_BYTES: 10485760,
    INGEST_MAX_DECOMPRESSED_BYTES: 200 * 1024 * 1024,
    METRICS_HOST: "127.0.0.1",
    METRICS_PORT: 9464,
    GATEWAY_BUFFER_WINDOW_MS: 500,
    GATEWAY_BUFFER_WINDOW_BYTES: 2048,
    GATEWAY_REDIS_FAILURE_MODE: "strict",
    GATEWAY_IDEMPOTENCY_TTL_SEC: 300,
    GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC: 3600,
    GATEWAY_TRUSTED_PROXIES: "",
    GATEWAY_AUTH_FAIL_MAX: 10,
    GATEWAY_AUTH_FAIL_WINDOW_SEC: 300,
    GATEWAY_AUTH_FAIL_BLOCK_SEC: 900,
    GATEWAY_OAUTH_REFRESH_LEAD_MIN: 10,
    GATEWAY_OAUTH_MAX_FAIL: 3,
    GATEWAY_UPSTREAM_AUTH_MAX_FAIL: 3,
    GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC: 3600,
    GATEWAY_UPSTREAM_AUTH_GRACE_SEC: 120,
    GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL: "https://console.anthropic.com/v1/oauth/token",
    GATEWAY_QUEUE_SATURATE_THRESHOLD: 5000,
    GATEWAY_APIKEY_RPM_LIMIT: 600,
    API_TRPC_RPM_LIMIT: 2000,
    GATEWAY_CACHE_TTL_SEC: 0,
    GATEWAY_LOCAL_BASE_URL: "http://localhost:3002",
    GATEWAY_ENABLE_MODEL_ALIAS: true,
    GATEWAY_MODEL_REGISTRY_REFRESH_SEC: 3600,
    ENABLE_EVALUATOR: false,
    ENABLE_FACET_EXTRACTION: false,
    EVALUATOR_BUDGET_ENFORCE_DEEP_ANALYSIS: true,
    ENABLE_PROJECT_EVALUATION: false,
    EVALUATOR_MAX_PROJECT_KEYS_PER_USER: 20,
    MAX_PROJECT_KEYS_PER_ORG: 50,
    ...overrides,
  };
}

describe("redisPlugin", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
  });

  it("1. decorates fastify.redis with the injected client", async () => {
    const mock = new RedisMock();
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();
    expect(app.redis).toBe(mock);
  });

  it("2. set/get round-trip works via the injected client", async () => {
    const mock = new RedisMock();
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();
    await app.redis.set("foo", "bar");
    const val = await app.redis.get("foo");
    expect(val).toBe("bar");
  });

  it("3. onClose hook calls quit on the client", async () => {
    const mock = new RedisMock();
    const quitSpy = vi.spyOn(mock, "quit");
    const app = Fastify({ logger: false });
    // do NOT push — we close manually to verify
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();
    await app.close();
    expect(quitSpy).toHaveBeenCalledOnce();
  });

  it("4. forwards reconnecting events to fastify.log.warn", async () => {
    const warnSpy = vi.fn();
    const mock = new RedisMock();
    const app = Fastify({
      logger: { level: "warn" },
    });
    apps.push(app);
    // Override log.warn so we can assert
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();

    // Patch the already-resolved log instance
    app.log.warn = warnSpy;

    mock.emit("reconnecting", 500);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 500 }),
      "redis reconnecting",
    );
  });

  it("5. error event → fastify.log.warn with err message", async () => {
    const warnSpy = vi.fn();
    const mock = new RedisMock();
    const app = Fastify({ logger: { level: "warn" } });
    apps.push(app);
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();

    app.log.warn = warnSpy;

    const testErr = new Error("connection refused");
    mock.emit("error", testErr);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: "connection refused" }),
      "redis error",
    );
  });

  it("6. missing REDIS_URL throws when no client injection", async () => {
    const app = Fastify({ logger: false });
    // Do not push — will throw before ready
    await expect(
      app.register(redisPlugin, {
        env: makeEnv({ REDIS_URL: undefined }),
      }),
    ).rejects.toThrow("REDIS_URL required when gateway is enabled");
    await app.close();
  });

  it("7. quit() failure is logged at debug level", async () => {
    const mock = new RedisMock();
    const quitError = new Error("already closed");
    vi.spyOn(mock, "quit").mockRejectedValueOnce(quitError);

    const app = Fastify({ logger: { level: "debug" } });
    // do NOT push — we close manually
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();

    const debugSpy = vi.spyOn(app.log, "debug");
    await app.close();

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: "already closed" }),
      "redis quit failed (likely already closed)",
    );
  });

  it("8. keyPrefix caliber:gw: is applied — key stored with prefix in ioredis-mock store", async () => {
    const mock = new RedisMock({ keyPrefix: "caliber:gw:" });
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(redisPlugin, { env: makeEnv(), client: mock as never });
    await app.ready();

    await app.redis.set("mykey", "myval");

    // ioredis-mock honors keyPrefix: the on-wire key in the store is prefixed.
    // mock.data is a Map-like object; use .keys() (not Object.keys) to iterate it.
    const mockData = (mock as unknown as { data: Map<string, unknown> }).data;
    const storeKeys = [...mockData.keys()];
    expect(storeKeys).toContain("caliber:gw:mykey");

    // Round-trip via the same prefixed client works
    const val = await app.redis.get("mykey");
    expect(val).toBe("myval");

    // A fresh mock without keyPrefix cannot find the key at the unprefixed path
    const rawMock = new RedisMock();
    const rawVal = await rawMock.get("mykey");
    expect(rawVal).toBeNull();
  });
});
