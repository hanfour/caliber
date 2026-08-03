/**
 * End-to-end anti-forgery test for the `x-caliber-replay-of` header
 * (Task 3, single-request-replay).
 *
 * Threat model: `usage_logs.replay_of_request_id` is what excludes a row from
 * `usage_logs_scored` (Task 1/2). If an ordinary member's api key could set
 * this header on their own traffic, they could hide their own requests from
 * their performance evaluation. `replayOfHeader()` closes this by trusting
 * the header ONLY when the request authenticated with an eval key
 * (`keyPrefix === "caliber-eval"`) — a prefix external clients cannot hold.
 *
 * This test drives a real request through the real Fastify app (auth
 * middleware, route handler, usage-log payload assembly) with an ordinary
 * `own`-policy member api key, exactly as an attacker would have to. It does
 * NOT call `replayOfHeader()` or `buildUsageLogPayload()` directly — that
 * would only prove the unit, not that the route wiring actually applies the
 * guard.
 *
 * Modeled on `messagesAlias.integration.test.ts` (same server/seed/stub-queue
 * pattern).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createServer, type Server } from "node:http";
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
  usageLogs,
  type Database,
} from "@caliber/db";
import { REPLAY_OF_HEADER } from "../../src/runtime/replayOfHeader.js";
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
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

// ── Fake upstream (Anthropic) HTTP server ────────────────────────────────────

let fakeServer: Server;
let fakeBaseUrl: string;

beforeAll(async () => {
  fakeServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_forgery_echo",
          type: "message",
          role: "assistant",
          model: "claude-forgery-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
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

// ── Environment helper ───────────────────────────────────────────────────────

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
    REDIS_URL: "redis://localhost:6379",
    CREDENTIAL_ENCRYPTION_KEY: masterKey,
    API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fakeBaseUrl,
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

async function seedUser(): Promise<string> {
  const email = `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const [user] = await db.insert(users).values({ email }).returning();
  return user!.id;
}

/**
 * Seed an ordinary member api key — NOT an eval key. `keyPrefix` is the raw
 * key's own leading characters (`ak_forge_...`), which never equals
 * `"caliber-eval"`. This is the exact key shape an attacker attempting the
 * forgery in this test's threat model would hold.
 */
async function seedMemberKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<void> {
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-key-member",
    groupId: null,
    routingPolicy: "own",
  });
}

/** Seed a single user-owned OAuth anthropic upstream + its credential. */
async function seedOwnOauthAccount(
  orgId: string,
  userId: string,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      userId,
      name: "own-oauth-acct",
      platform: "anthropic",
      type: "oauth",
      schedulable: true,
      status: "active",
    })
    .returning();

  const oauthPayload = JSON.stringify({
    type: "oauth",
    access_token: "oauth-access-token-test",
    refresh_token: "oauth-refresh-token-test",
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: oauthPayload,
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

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  const app = await buildServer({ env, db, redis: redisMock });
  // Injected-redis (test) path skips BullMQ, so `app.usageLogQueue` is
  // undefined and emitUsageLog no-ops. Decorate a stub queue whose `add`
  // rejects → `enqueueUsageLog` writes the row inline to the DB via its
  // fallback, letting us assert the persisted `replay_of_request_id`.
  (app as unknown as { usageLogQueue: unknown }).usageLogQueue = {
    add: () => Promise.reject(new Error("stub: force inline DB fallback")),
  };
  return app;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe("x-caliber-replay-of header — anti-forgery (real request path)", () => {
  it("一般成員 key 帶 x-caliber-replay-of 時，該欄位必須為 null（照常計入評分）", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_forge_${Math.random().toString(36).slice(2)}`;
    await seedMemberKey(orgId, userId, rawKey);
    await seedOwnOauthAccount(orgId, userId);

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${rawKey}`,
        // The forged marker — an ordinary member key can never make this
        // header stick. If the guard regressed, this would flip the row's
        // replay_of_request_id to "req-victim", silently pulling the
        // request out of the caller's own performance scoring.
        [REPLAY_OF_HEADER]: "req-victim",
      },
      payload: {
        model: "claude-forgery-test",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(res.statusCode).toBe(200);

    // Allow the fire-and-forget emit to flush before reading the row back.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db
      .select({ replayOfRequestId: usageLogs.replayOfRequestId })
      .from(usageLogs)
      .where(and(eq(usageLogs.orgId, orgId), eq(usageLogs.userId, userId)));

    expect(rows.length).toBe(1);
    expect(rows[0]!.replayOfRequestId).toBeNull();

    await app.close();
  });
});
