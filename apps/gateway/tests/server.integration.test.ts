/**
 * Server lifecycle integration test (Plan 4A Part 7, Sub-task A).
 *
 * Stands up real Postgres + Redis testcontainers and exercises the full
 * `buildServer` boot path with NO opts.redis injection — i.e., the production
 * BullMQ wiring: dedicated ioredis connection, Queue, UsageLogWorker,
 * BillingAudit. Verifies:
 *
 *   1. `fastify.usageLogQueue` is decorated after boot.
 *   2. `app.close()` tears everything down cleanly (no open handles / throws).
 *
 * Per-job correctness (batched writes, DLQ, drift detection) is covered in the
 * per-worker integration tests. This file focuses narrowly on the server-side
 * lifecycle glue introduced in Sub-task A — making sure the onClose hook
 * ordering and resource teardown actually works end-to-end against real infra.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RedisContainer,
  type StartedRedisContainer,
} from "@testcontainers/redis";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import type { Database } from "@caliber/db";
import { buildServer } from "../src/server.js";
import { parseServerEnv, type ServerEnv } from "@caliber/config";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const validBase = {
  NODE_ENV: "test",
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

function makeEnv(overrides: Record<string, string>): ServerEnv {
  return parseServerEnv({ ...validBase, ...overrides });
}

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;
let redisContainer: StartedRedisContainer;
let redisUrl: string;
let databaseUrl: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  databaseUrl = pgContainer.getConnectionUri();
  pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  redisContainer = await new RedisContainer("redis:7-alpine").start();
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getPort()}`;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
  await redisContainer.stop();
});

describe("gateway server lifecycle (integration)", () => {
  it("decorates fastify.usageLogQueue and tears down cleanly on app.close()", async () => {
    const env = makeEnv({
      ENABLE_GATEWAY: "true",
      GATEWAY_BASE_URL: "http://localhost:3002",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
      API_KEY_HASH_PEPPER: "b".repeat(64),
    });

    // Passing `db` but NOT `redis` exercises the production BullMQ wiring
    // path against the real Redis container.
    const app = await buildServer({ env, db });

    expect(app.usageLogQueue).toBeDefined();
    expect(app.hasDecorator("usageLogQueue")).toBe(true);

    // Sanity check: /health still responds after full BullMQ wiring.
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);

    // The onClose hook must drain audit → worker → queue → bullmqRedis
    // without throwing. If any step hangs, vitest's hookTimeout catches it.
    await expect(app.close()).resolves.not.toThrow();
  });
});
