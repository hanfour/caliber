/**
 * Streaming integration tests for POST /v1/messages with stream=true.
 *
 * Uses app.inject which collects the full SSE body. This lets us verify:
 *   - Happy-path streaming (all chunks delivered)
 *   - Pre-commit failover (first account errors → second account's bytes only)
 *   - Post-commit error (partial stream + synthetic event:error chunk)
 *   - Short stream committed via buffer.commit()
 *   - Failover exhausted in stream mode (JSON 503 before headers sent)
 *   - stream=false regression with new runFailover + maybeRefreshOAuth path
 *
 * NOTE: Client-disconnect (AbortSignal) is not testable via app.inject because
 * inject does not expose a way to close mid-stream. Covered by SmartBuffer unit
 * tests and manual integration testing.
 *
 * NOTE (#88): app.inject also does not exercise the real `req.raw` /
 * `reply.raw` socket pair — the disconnect-detection path inside the
 * for-await stream loop is not reached during inject runs. The bug fixed
 * by switching `req.raw.destroyed` → `reply.raw.destroyed` (every
 * streaming request returned 0 bytes under fastify keep-alive) shipped
 * green here. Until a listen-based regression test exists, reviewers
 * should grep for `req.raw.destroyed` in stream paths — if it's back,
 * the bug is back.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import {
  organizations,
  users,
  apiKeys,
  upstreamAccounts,
  credentialVault,
  type Database,
} from "@caliber/db";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Postgres container ──────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

// ── Fake upstream (Anthropic) HTTP server ────────────────────────────────────
//
// Supports a queue of "scenarios" consumed one at a time.
// Each scenario describes how the server should respond to one incoming request.

type UpstreamScenario =
  | { kind: "non-stream"; status: number; body: string }
  | {
      kind: "sse";
      status: number;
      chunks: string[];
      /**
       * If set, the server sends the initial chunks then destroys the socket
       * mid-stream (simulates a broken connection after partial data).
       */
      destroyAfterChunks?: number;
    }
  | { kind: "close-socket" };

let fakeServer: Server;
let fakeBaseUrl: string;
const scenarioQueue: UpstreamScenario[] = [];

function pushScenario(s: UpstreamScenario): void {
  scenarioQueue.push(s);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const scenario = scenarioQueue.shift();

  if (!scenario) {
    // Default: empty 200 SSE
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.end();
    return;
  }

  if (scenario.kind === "close-socket") {
    req.socket.destroy();
    return;
  }

  if (scenario.kind === "non-stream") {
    res.statusCode = scenario.status;
    res.setHeader("content-type", "application/json");
    res.end(scenario.body);
    return;
  }

  // SSE scenario
  res.statusCode = scenario.status;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");

  const destroyAt = scenario.destroyAfterChunks ?? Infinity;
  for (let i = 0; i < scenario.chunks.length; i++) {
    if (i >= destroyAt) {
      req.socket.destroy();
      return;
    }
    res.write(scenario.chunks[i]);
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

beforeEach(() => {
  scenarioQueue.length = 0;
});

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// ── Environment helper ───────────────────────────────────────────────────────

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
    REDIS_URL: "redis://localhost:6379",
    CREDENTIAL_ENCRYPTION_KEY: masterKey,
    API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fakeBaseUrl,
    // Use a generous buffer window so most tests end before commit fires.
    // Individual tests can override.
    GATEWAY_BUFFER_WINDOW_MS: "500",
    GATEWAY_BUFFER_WINDOW_BYTES: "2048",
    ...overrides,
  };
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seedOrg(): Promise<string> {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`;
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: "Test Org" })
    .returning();
  return org!.id;
}

async function seedUser(orgId: string): Promise<string> {
  const email = `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const [user] = await db.insert(users).values({ email }).returning();
  return user!.id;
}

async function seedApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<void> {
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-key",
  });
}

async function seedAccount(
  orgId: string,
  plaintextCredential: string,
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-acct",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      ...overrides,
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: plaintextCredential,
  });

  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });

  return acct!.id;
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeRedisMock(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

async function makeApp(
  redisMock: Redis,
  connectionString: string,
  envOverrides: Record<string, unknown> = {},
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString, envOverrides));
  return buildServer({ env, db, redis: redisMock });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /v1/messages — streaming", () => {
  it("1. happy stream path — client receives all SSE chunks", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s1_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    const chunk1 = 'event: ping\ndata: {"type":"ping"}\n\n';
    const chunk2 = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    pushScenario({ kind: "sse", status: 200, chunks: [chunk1, chunk2] });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body).toContain("event: ping");
    expect(res.body).toContain("event: message_start");
    // Total body bytes = both chunks concatenated
    expect(res.body).toBe(chunk1 + chunk2);

    await app.close();
  });

  it("2. pre-commit failover — first account errors within buffer window; client only sees second account's bytes", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s2_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);

    // Two accounts — failover loop will try account1 first, then account2.
    // We seed account2 first (lower priority) then account1 (higher priority).
    // selectAccounts orders by createdAt/id; seed account1 second so it wins.
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-acct2" }),
      { name: "acct2" },
    );
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-acct1" }),
      { name: "acct1" },
    );

    // Scenario queue: first request (account1) errors with 500 (transient → switch).
    // Second request (account2) streams successfully.
    const successChunk =
      'event: message_start\ndata: {"type":"message_start"}\n\n';
    pushScenario({
      kind: "non-stream",
      status: 500,
      body: '{"error":"internal"}',
    });
    pushScenario({
      kind: "sse",
      status: 200,
      chunks: [successChunk],
    });

    const redis = makeRedisMock();
    // Set tiny buffer window to ensure we stay in BUFFERING for the fast error.
    const app = await makeApp(redis, container.getConnectionUri(), {
      GATEWAY_BUFFER_WINDOW_MS: "5000", // large so we don't commit during test
      GATEWAY_BUFFER_WINDOW_BYTES: "65536",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // Client should only see the second account's successful stream bytes.
    expect(res.body).toBe(successChunk);
    // Confirm we did NOT receive the error body from the first attempt.
    expect(res.body).not.toContain("internal");

    await app.close();
  });

  it("3. byte-threshold commit — multi-chunk stream; chunks after commit arrive via passthrough", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s3_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    // First chunk trips byte threshold (2049 > 2048) → SmartBuffer commits.
    // Second chunk arrives after commit → goes through onPassthrough.
    // Both chunks should appear in the final body.
    const bigChunk = "x".repeat(2049);
    const firstSse = `event: data\ndata: ${bigChunk}\n\n`;
    const secondSse = 'event: ping\ndata: {"type":"ping"}\n\n';
    pushScenario({
      kind: "sse",
      status: 200,
      chunks: [firstSse, secondSse],
    });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri(), {
      GATEWAY_BUFFER_WINDOW_MS: "60000", // disable time-based commit
      GATEWAY_BUFFER_WINDOW_BYTES: "2048", // trip on first chunk
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // Both chunks must be present — first committed, second via passthrough.
    expect(res.body).toContain(bigChunk);
    expect(res.body).toContain("event: ping");
    expect(res.body).toBe(firstSse + secondSse);

    await app.close();
  });

  it("4. short upstream ends before window expires — committed via buffer.commit()", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s4_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    // Small payload, well under byte threshold, finishes before time window.
    const chunk = 'event: ping\ndata: {"type":"ping"}\n\n';
    pushScenario({ kind: "sse", status: 200, chunks: [chunk] });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri(), {
      GATEWAY_BUFFER_WINDOW_MS: "5000", // well after stream ends
      GATEWAY_BUFFER_WINDOW_BYTES: "65536",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    // buffer.commit() should have been called when the upstream ended.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(chunk);

    await app.close();
  });

  it("5. failover exhausted in stream mode — JSON 503 before any headers sent", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s5_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    // All attempts fail with 500 (transient → switch) until pool exhausted.
    // With GATEWAY_MAX_ACCOUNT_SWITCHES=1 we only try once.
    pushScenario({
      kind: "non-stream",
      status: 500,
      body: '{"error":"server error"}',
    });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri(), {
      GATEWAY_MAX_ACCOUNT_SWITCHES: "1",
      GATEWAY_BUFFER_WINDOW_MS: "5000",
      GATEWAY_BUFFER_WINDOW_BYTES: "65536",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    // Headers not yet sent when failover exhausted → JSON 503
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const json = res.json() as Record<string, unknown>;
    expect(json.error).toBe("all_upstreams_failed");

    await app.close();
  });

  it("6. empty stream — upstream ends with no chunks; clean 200 with SSE headers", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s6_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    pushScenario({ kind: "sse", status: 200, chunks: [] });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body).toBe("");

    await app.close();
  });

  it("7. slot released after successful stream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s7_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    pushScenario({
      kind: "sse",
      status: 200,
      chunks: ['event: ping\ndata: {"type":"ping"}\n\n'],
    });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);

    // Slot ZSET should be empty after the request.
    const slotKey = `slots:account:${accountId}`;
    const count = await redis.zcard(slotKey);
    expect(count).toBe(0);

    await app.close();
  });

  it("8. stream=false regression — non-stream path with runFailover + maybeRefreshOAuth (api_key, no refresh)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_s8_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
    );

    // Non-stream upstream response.
    pushScenario({
      kind: "non-stream",
      status: 200,
      body: '{"id":"msg_regression","content":[]}',
    });

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "msg_regression" });

    await app.close();
  });
});
