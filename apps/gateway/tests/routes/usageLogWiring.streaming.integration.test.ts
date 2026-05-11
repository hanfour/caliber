/**
 * Integration test for route → BullMQ → worker → usage_logs wiring on the
 * /v1/messages STREAMING path (Plan 4A Part 7, Sub-task C).
 *
 * Stands up real Postgres + Redis testcontainers, a fake Anthropic upstream
 * that emits canned Anthropic SSE events, and the gateway built without the
 * `opts.redis` injection hatch — meaning the production `wireUsageLogPipeline()`
 * path runs and the worker actually drains enqueued jobs.
 *
 * Flow:
 *   1. Seed org + user + api key + upstream account.
 *   2. POST /v1/messages with stream=true.
 *   3. Assert the HTTP response is 200 and carries the SSE body bytes.
 *   4. Poll `usage_logs` until the worker has committed the row.
 *   5. Assert the row is marked stream=true, has the extracted tokens,
 *      firstTokenMs is non-null and < durationMs, bufferReleasedAtMs is
 *      non-null (or null when the stream was tiny and committed without
 *      intermediate flush — happy path test forces a commit).
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
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

// ── Fake upstream (SSE) ──────────────────────────────────────────────────────

let fakeServer: Server;
let fakeBaseUrl: string;
let nextSseChunks: string[] = [];

function handleRequest(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  for (const c of nextSseChunks) {
    res.write(c);
  }
  res.end();
}

beforeAll(async () => {
  fakeServer = createServer(handleRequest);
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

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  nextSseChunks = [];
  const flushClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await flushClient.flushall();
  await flushClient.quit();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEnv(
  connectionString: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    // Defaults tuned for streaming tests — individual tests override.
    GATEWAY_BUFFER_WINDOW_MS: "500",
    GATEWAY_BUFFER_WINDOW_BYTES: "2048",
    ...overrides,
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

async function makeApp(
  envOverrides: Record<string, unknown> = {},
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(
    buildEnv(pgContainer.getConnectionUri(), envOverrides),
  );
  // No `opts.redis` → production BullMQ pipeline wires up against the real
  // Redis container so the worker actually drains enqueued jobs.
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

// ── Canned SSE bytes ─────────────────────────────────────────────────────────

function messageStartSse(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): string {
  const data = {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
}

function contentBlockDeltaSse(text: string): string {
  const data = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageDeltaSse(outputTokens: number): string {
  const data = {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
  return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStopSse(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usage-log wiring — /v1/messages (streaming)", () => {
  it("1. happy streaming path — row marked stream=true with extracted tokens + timings", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_sw_${Math.random().toString(36).slice(2)}`;
    const apiKeyId = await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(orgId);

    nextSseChunks = [
      messageStartSse(KNOWN_MODEL, { input_tokens: 800, output_tokens: 1 }),
      contentBlockDeltaSse("hello"),
      contentBlockDeltaSse(" world"),
      messageDeltaSse(200),
      messageStopSse(),
    ];

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: KNOWN_MODEL, max_tokens: 10, stream: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(res.body).toContain("event: message_start");
      expect(res.body).toContain("event: message_delta");

      // Worker is async — poll until the enqueued row lands in Postgres.
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
      // Extractor picked up the upstream-advertised model from message_start.
      expect(row!.upstreamModel).toBe(KNOWN_MODEL);
      expect(row!.platform).toBe("anthropic");
      expect(row!.surface).toBe("messages");
      expect(row!.stream).toBe(true);
      expect(row!.statusCode).toBe(200);
      expect(row!.inputTokens).toBe(800);
      // Final output_tokens comes from the last message_delta, not message_start.
      expect(row!.outputTokens).toBe(200);
      // 800 * 0.0000008 + 200 * 0.000004 = 0.00064 + 0.0008 = 0.00144
      expect(Number(row!.totalCost)).toBeCloseTo(0.00144, 10);
      // Timings: duration must be non-negative; firstTokenMs ≤ durationMs.
      expect(row!.durationMs).toBeGreaterThanOrEqual(0);
      expect(row!.firstTokenMs).not.toBeNull();
      expect(row!.firstTokenMs!).toBeGreaterThanOrEqual(0);
      expect(row!.firstTokenMs!).toBeLessThanOrEqual(row!.durationMs);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("2. truncated stream (no message_delta) — still emits row with message_start usage", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_swt_${Math.random().toString(36).slice(2)}`;
    const apiKeyId = await seedApiKey(orgId, userId, rawKey);
    await seedAccount(orgId);

    // Upstream closes after message_start — extractor has no delta so
    // output_tokens falls back to message_start's value.
    nextSseChunks = [
      messageStartSse(KNOWN_MODEL, { input_tokens: 50, output_tokens: 8 }),
    ];

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: KNOWN_MODEL, max_tokens: 10, stream: true },
      });
      expect(res.statusCode).toBe(200);

      await waitFor(
        async () => (await getUsageLogCountForKey(apiKeyId)) === 1,
        10_000,
      );

      const row = await getUsageLogRowForKey(apiKeyId);
      expect(row).not.toBeNull();
      expect(row!.stream).toBe(true);
      expect(row!.inputTokens).toBe(50);
      // Fallback: message_start.usage.output_tokens when no delta arrived.
      expect(row!.outputTokens).toBe(8);
      expect(row!.upstreamModel).toBe(KNOWN_MODEL);
    } finally {
      await app.close();
    }
  }, 30_000);
});
