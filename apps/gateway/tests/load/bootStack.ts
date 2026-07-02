import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import * as schema from "@caliber/db/schema";
import type { Database } from "@caliber/db";
import { parseServerEnv } from "@caliber/config";
import { buildServer } from "../../src/server.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { masterKey, pepper } from "./seed.js";
import { truncateData, clearGatewayKeyspace } from "./cleanup.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(path.dirname(require.resolve("@caliber/db/package.json")), "drizzle");

export interface BootOptions {
  /** Suite-fixed knobs — captured at plugin registration, NOT mutable per scenario. */
  maxWait?: number;          // GATEWAY_MAX_WAIT (default 10)
  maxSwitches?: number;      // GATEWAY_MAX_ACCOUNT_SWITCHES (default 10)
  authMaxFail?: number;      // GATEWAY_UPSTREAM_AUTH_MAX_FAIL (default 3)
  // GATEWAY_APIKEY_RPM_LIMIT — per-api-key requests/min. Undefined keeps the
  // config default (600); 0 disables enforcement (the perf harness sets 0 so
  // the load test measures gateway throughput, not the rate limiter). Omitted
  // from `env` when undefined so correctness suites keep the 600 default.
  apikeyRpmLimit?: number;
}

export interface LoadStack {
  baseUrl: string;
  db: Database;
  /** caliber:gw:-prefixed client for slot-ZSET inspection (e.g. zcard("slots:account:<id>")). */
  redis: Redis;
  fake: FakeUpstream;
  app: Awaited<ReturnType<typeof buildServer>>;
  env: { maxWait: number; maxSwitches: number; authMaxFail: number };
  /** afterEach: TRUNCATE data + clear caliber:gw* keyspace. */
  resetState(): Promise<void>;
  teardown(): Promise<void>;
}

export async function bootStack(opts: BootOptions = {}): Promise<LoadStack> {
  const maxWait = opts.maxWait ?? 10;
  const maxSwitches = opts.maxSwitches ?? 10;
  const authMaxFail = opts.authMaxFail ?? 3;

  const pgC: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  const db = drizzle(pool, { schema });
  await migrate(db as never, { migrationsFolder });

  const redisC: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const redisUrl = redisC.getConnectionUrl();

  const fake = await startFakeUpstream();

  const env = parseServerEnv({
    NODE_ENV: "test", DATABASE_URL: pgC.getConnectionUri(),
    AUTH_SECRET: "test-auth-secret-min-32-chars-long!!", NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com", BOOTSTRAP_DEFAULT_ORG_SLUG: "test-org", BOOTSTRAP_DEFAULT_ORG_NAME: "Test Org",
    ENABLE_GATEWAY: "true", GATEWAY_BASE_URL: "http://localhost:3002",
    REDIS_URL: redisUrl,
    CREDENTIAL_ENCRYPTION_KEY: masterKey, API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fake.baseUrl, UPSTREAM_OPENAI_BASE_URL: fake.baseUrl,
    GATEWAY_ENABLE_MODEL_ALIAS: "false", GATEWAY_CACHE_TTL_SEC: "0",
    GATEWAY_MAX_WAIT: String(maxWait),
    GATEWAY_MAX_ACCOUNT_SWITCHES: String(maxSwitches),
    GATEWAY_UPSTREAM_AUTH_MAX_FAIL: String(authMaxFail),
    // Only override the per-api-key rpm limit when explicitly given; otherwise
    // the config schema default (600) applies, as correctness suites expect.
    ...(opts.apikeyRpmLimit !== undefined
      ? { GATEWAY_APIKEY_RPM_LIMIT: String(opts.apikeyRpmLimit) }
      : {}),
  });

  // opts.redis OMITTED → production BullMQ wiring runs against the real container.
  const app = await buildServer({ env, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Inspection client: same caliber:gw: prefix as the gateway's internal client.
  const redis = new Redis(redisUrl, { keyPrefix: "caliber:gw:" });
  // Cleanup client: RAW (un-prefixed) so SCAN MATCH caliber:gw* sees real keys.
  const rawRedis = new Redis(redisUrl);

  return {
    baseUrl, db, redis, fake, app,
    env: { maxWait, maxSwitches, authMaxFail },
    resetState: async () => {
      await truncateData(db);
      await clearGatewayKeyspace(rawRedis);
      fake.reset();
    },
    teardown: async () => {
      await app.close();
      await fake.stop();
      redis.disconnect();
      rawRedis.disconnect();
      await pool.end();
      await pgC.stop();
      await redisC.stop();
    },
  };
}
