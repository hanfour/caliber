/**
 * Integration test for route → BullMQ → worker → usage_logs wiring
 * (Plan 4A Part 7, Sub-task B).
 *
 * Stands up real Postgres + Redis testcontainers, a fake Anthropic upstream,
 * and the gateway built without the `opts.redis` injection hatch — meaning
 * the production `wireUsageLogPipeline()` path runs and the worker actually
 * drains enqueued jobs. For each route:
 *
 *   1. Seed org + user + api key + upstream account.
 *   2. POST a well-formed request (Anthropic payload for /v1/messages,
 *      OpenAI payload for /v1/chat/completions).
 *   3. Assert the HTTP response is 200.
 *   4. Poll `usage_logs` until the worker has committed the row (BullMQ job
 *      processing is async).
 *   5. Assert the row has the right fields + `api_keys.quota_used_usd` was
 *      bumped by `actual_cost_usd`.
 *   6. Pricing-miss case: unknown model → cost zero, no enqueue error,
 *      row still appears.
 *
 * Uses a real `pricing/litellm.json` entry (`claude-3-5-haiku-20241022`) as
 * the "known pricing" model and an invented string as the "pricing miss"
 * model so the assertion about `totalCost > 0` vs `totalCost === 0` is
 * stable regardless of future pricing edits.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import { eq, sql } from "drizzle-orm";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import {
  organizations,
  users,
  apiKeys,
  upstreamAccounts,
  credentialVault,
  usageLogs,
  type Database,
} from "@caliber/db";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Containers ───────────────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let redisContainer: StartedRedisContainer;
let redisUrl: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });

  redisContainer = await new RedisContainer("redis:7-alpine").start();
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getPort()}`;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
  await redisContainer.stop();
}, 30_000);

// ── Fake upstream ────────────────────────────────────────────────────────────

let fakeServer: Server;
let fakeBaseUrl: string;
let nextUpstreamBody: string;

beforeAll(async () => {
  nextUpstreamBody = JSON.stringify({
    id: "msg_default",
    type: "message",
    role: "assistant",
    model: "claude-3-5-haiku-20241022",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  fakeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(nextUpstreamBody);
    });
  });
  await new Promise<void>((resolve) =>
    fakeServer.listen(0, "127.0.0.1", resolve),
  );
  const addr = fakeServer.address() as AddressInfo;
  fakeBaseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () => new Promise<void>((resolve) => fakeServer.close(() => resolve())),
);

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// Matches a real entry in packages/gateway-core/pricing/litellm.json so
// resolveCost returns miss=false + non-zero totals.
const KNOWN_MODEL = "claude-3-5-haiku-20241022";
// Not present in pricing map → miss=true, all costs zero.
const UNKNOWN_MODEL = "caliber-test-unknown-model-xyz";

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  // Don't truncate api_keys / users / orgs — tests seed their own ids.

  // Flush the test Redis between tests so leftover BullMQ keys (e.g.,
  // completed-job metadata, failed-job retries) from one test don't
  // confuse the next test's worker lifecycle. Mirrors the pattern from
  // `tests/workers/usageLogWorker.integration.test.ts`.
  const flushClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await flushClient.flushall();
  await flushClient.quit();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEnv(connectionString: string): Record<string, unknown> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: connectionString,
    AUTH_SECRET: "test-auth-secret-min-32-chars-long!!",
    NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test-google-id",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GITHUB_CLIENT_ID: "test-github-id",
    GITHUB_CLIENT_SECRET: "test-github-secret",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com",
    BOOTSTRAP_DEFAULT_ORG_SLUG: "test-org",
    BOOTSTRAP_DEFAULT_ORG_NAME: "Test Org",
    ENABLE_GATEWAY: "true",
    GATEWAY_BASE_URL: "http://localhost:3002",
    REDIS_URL: redisUrl,
    CREDENTIAL_ENCRYPTION_KEY: masterKey,
    API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fakeBaseUrl,
  };
}

async function seedOrg(): Promise<string> {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`;
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: "T" })
    .returning();
  return org!.id;
}

async function seedUser(): Promise<string> {
  const email = `u-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const [user] = await db.insert(users).values({ email }).returning();
  return user!.id;
}

async function seedApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<string> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId,
      userId,
      keyHash: hashApiKey(pepper, rawKey),
      keyPrefix: rawKey.slice(0, 8),
      name: "k",
      quotaUsd: "1000.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedAccount(orgId: string): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "a",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
    })
    .returning();
  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: "sk-test" }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });
  return acct!.id;
}

async function makeApp(): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(pgContainer.getConnectionUri()));
  // No `opts.redis` → production BullMQ pipeline wires up against the
  // real Redis container. The gateway also opens a real ioredis connection
  // for slot bookkeeping; both target the same test container.
  return buildServer({ env, db });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function getUsageLogCountForKey(apiKeyId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(usageLogs)
    .where(eq(usageLogs.apiKeyId, apiKeyId));
  return rows[0]?.c ?? 0;
}

async function getUsageLogRowForKey(apiKeyId: string) {
  const rows = await db
    .select()
    .from(usageLogs)
    .where(eq(usageLogs.apiKeyId, apiKeyId))
    .limit(1);
  return rows[0] ?? null;
}

async function getQuotaUsed(apiKeyId: string): Promise<string> {
  const rows = await db
    .select({ used: apiKeys.quotaUsedUsd })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  return rows[0]?.used ?? "0";
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usage-log wiring — /v1/messages (non-streaming)", () => {
  it("1. happy path — worker drains enqueued row + quota bumped", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_mwire_${Math.random().toString(36).slice(2)}`;
    const apiKeyId = await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(orgId);

    nextUpstreamBody = JSON.stringify({
      id: "msg_wire_1",
      type: "message",
      role: "assistant",
      model: KNOWN_MODEL,
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: KNOWN_MODEL, max_tokens: 10 },
      });
      expect(res.statusCode).toBe(200);

      // Fastify 5 does not reflect req.id in response headers by default,
      // so we look up the row by api_key_id (which is unique per test —
      // each test seeds its own key) instead of by requestId.
      await waitFor(
        async () => (await getUsageLogCountForKey(apiKeyId)) === 1,
        10_000,
      );

      const row = await getUsageLogRowForKey(apiKeyId);
      expect(row).not.toBeNull();
      expect(row!.apiKeyId).toBe(apiKeyId);
      expect(row!.accountId).toBe(accountId);
      expect(row!.userId).toBe(userId);
      expect(row!.orgId).toBe(orgId);
      expect(row!.requestedModel).toBe(KNOWN_MODEL);
      expect(row!.upstreamModel).toBe(KNOWN_MODEL);
      expect(row!.platform).toBe("anthropic");
      expect(row!.surface).toBe("messages");
      expect(row!.stream).toBe(false);
      expect(row!.statusCode).toBe(200);
      expect(row!.inputTokens).toBe(1000);
      expect(row!.outputTokens).toBe(500);
      // 1000 * 0.0000008 + 500 * 0.000004 = 0.0008 + 0.002 = 0.0028
      expect(Number(row!.totalCost)).toBeCloseTo(0.0028, 10);

      // Quota bump equals total_cost (worker guarantees transactional match).
      const used = await getQuotaUsed(apiKeyId);
      expect(Number(used)).toBeCloseTo(0.0028, 10);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("2. pricing miss — row created with zero cost, no error", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_mmiss_${Math.random().toString(36).slice(2)}`;
    const apiKeyId = await seedApiKey(orgId, userId, rawKey);
    await seedAccount(orgId);

    nextUpstreamBody = JSON.stringify({
      id: "msg_miss_1",
      type: "message",
      role: "assistant",
      model: UNKNOWN_MODEL,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 42, output_tokens: 17 },
    });

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: UNKNOWN_MODEL, max_tokens: 10 },
      });
      expect(res.statusCode).toBe(200);

      await waitFor(
        async () => (await getUsageLogCountForKey(apiKeyId)) === 1,
        10_000,
      );

      const row = await getUsageLogRowForKey(apiKeyId);
      expect(row).not.toBeNull();
      expect(row!.upstreamModel).toBe(UNKNOWN_MODEL);
      // Tokens still populated — forensic row even on price miss.
      expect(row!.inputTokens).toBe(42);
      expect(row!.outputTokens).toBe(17);
      // Costs all zero.
      expect(Number(row!.totalCost)).toBe(0);
      expect(Number(row!.inputCost)).toBe(0);
      expect(Number(row!.outputCost)).toBe(0);

      const used = await getQuotaUsed(apiKeyId);
      expect(Number(used)).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe("usage-log wiring — /v1/chat/completions", () => {
  it("3. happy path — enqueued + worker drains row + quota bumped", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_cwire_${Math.random().toString(36).slice(2)}`;
    const apiKeyId = await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(orgId);

    nextUpstreamBody = JSON.stringify({
      id: "msg_cwire",
      type: "message",
      role: "assistant",
      model: KNOWN_MODEL,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 50,
        },
      });
      expect(res.statusCode).toBe(200);

      await waitFor(
        async () => (await getUsageLogCountForKey(apiKeyId)) === 1,
        10_000,
      );

      const row = await getUsageLogRowForKey(apiKeyId);
      expect(row).not.toBeNull();
      expect(row!.apiKeyId).toBe(apiKeyId);
      expect(row!.accountId).toBe(accountId);
      expect(row!.platform).toBe("openai");
      expect(row!.surface).toBe("chat-completions");
      // requestedModel is the OpenAI client-sent model; upstreamModel is the
      // Anthropic model that actually served the request.
      expect(row!.requestedModel).toBe("gpt-4");
      expect(row!.upstreamModel).toBe(KNOWN_MODEL);
      expect(row!.inputTokens).toBe(200);
      expect(row!.outputTokens).toBe(100);
      // 200 * 0.0000008 + 100 * 0.000004 = 0.00016 + 0.0004 = 0.00056
      expect(Number(row!.totalCost)).toBeCloseTo(0.00056, 10);

      const used = await getQuotaUsed(apiKeyId);
      expect(Number(used)).toBeCloseTo(0.00056, 10);
    } finally {
      await app.close();
    }
  }, 30_000);
});
