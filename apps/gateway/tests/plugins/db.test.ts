import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { dbPlugin } from "../../src/plugins/db.js";
import { parseServerEnv } from "@caliber/config";

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
  ENABLE_GATEWAY: "true",
  GATEWAY_BASE_URL: "http://localhost:3002",
  REDIS_URL: "redis://localhost:6379",
  CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
  API_KEY_HASH_PEPPER: "b".repeat(64),
} as const;

const env = parseServerEnv(validBase);

describe("dbPlugin", () => {
  it("decorates fastify.db with the injected client", async () => {
    const fakeDb = { sentinel: true } as never;
    const app = Fastify({ logger: false });
    await app.register(dbPlugin, { env, db: fakeDb });
    await app.ready();
    expect(app.db).toBe(fakeDb);
    await app.close();
  });

  it("injected db takes precedence (no pool is created when db option is provided)", async () => {
    const fakeDb = { injected: true } as never;
    const app = Fastify({ logger: false });
    // Pass an obviously invalid DATABASE_URL — if a pool were created it would
    // attempt a connection and the test environment would surface an error.
    const envBadUrl = parseServerEnv({
      ...validBase,
      DATABASE_URL: "postgresql://invalid:0/nodb",
    });
    await app.register(dbPlugin, { env: envBadUrl, db: fakeDb });
    await app.ready();
    expect(app.db).toBe(fakeDb);
    await app.close();
  });
});
