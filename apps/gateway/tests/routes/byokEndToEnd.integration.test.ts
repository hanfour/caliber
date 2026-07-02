// BYOK P1 end-to-end capstone (Task 14).
//
// Proves the user-scoped-upstream slices (Tasks 1-13) compose end to end on a
// real testcontainer Postgres + the fully wired gateway app:
//
//   A. Happy path — a member with an `own`-policy key, an upstream they OWN
//      (upstream_accounts.user_id = caller), and a sealed credential gets the
//      request served BY their own upstream, and the usage_logs row records
//      `account_id = <caller's own upstream>` AND `user_id = <caller>`.
//
//   B. Cross-user isolation — a SECOND user's `pool` key, with both user A's
//      BYOK upstream and a pool upstream present, is NEVER served by A's BYOK
//      upstream (it routes to the pool row, or fails), so the usage_logs
//      account_id is never A's BYOK upstream id (B can't reach A's credential).
//
// Seeding mirrors the existing gateway route integration tests
// (chatCompletions/messages): we insert rows DIRECTLY (org, user, api_keys,
// upstream_accounts, credential_vault) rather than driving the tRPC mutations,
// which is the established pattern for gateway-only integration tests. The
// only BYOK-specific deltas are `userId` on the upstream + `routingPolicy:"own"`
// on the key.
//
// usage_logs note: in test mode (`opts.redis` injected) `buildServer` skips the
// BullMQ usage-log queue, so `emitUsageLog` normally no-ops without writing a
// row. To assert on the persisted row we decorate `app.usageLogQueue` with a
// fake whose `.add()` rejects — that drives `enqueueUsageLog`'s INLINE DB
// fallback (`writeUsageLogBatch`), the same production safety-net used when
// Redis is down. The row written is the real production payload.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
  accountGroups,
  accountGroupMembers,
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

// ── Fake upstream HTTP server ────────────────────────────────────────────────
//
// Every upstream in these tests is platform=openai, so the gateway dispatches
// to `/v1/responses` and we return a Responses-shaped 200 body.

let fakeServer: Server;
let fakeBaseUrl: string;

const responsesOkBody = JSON.stringify({
  id: "resp_byok_test",
  object: "response",
  created_at: 1700000000,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_byok",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "served", annotations: [] }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  incomplete_details: null,
});

beforeAll(async () => {
  fakeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(responsesOkBody);
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

// Each test runs against a clean usage_logs table so we can read the single
// row written by the request without keying on Fastify's internal req.id.
beforeEach(async () => {
  await db.delete(usageLogs);
});

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
    UPSTREAM_OPENAI_BASE_URL: fakeBaseUrl,
  };
}

// ── Seed helpers (mirror chatCompletions/messages integration tests) ─────────

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
 * Seed an api_keys row. BYOK delta vs the sibling tests: `routingPolicy` is
 * threaded through so we can issue an `own`-policy key. The routing_policy/group
 * mutex CHECK requires groupId IS NULL for any non-pool key, so a non-pool
 * `groupId` is rejected by the caller's choices, not enforced here.
 */
async function seedApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
  routingPolicy: "pool" | "own" | "own_then_pool" = "pool",
  groupId: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId,
      userId,
      keyHash: hashApiKey(pepper, rawKey),
      keyPrefix: rawKey.slice(0, 8),
      name: "test-key",
      groupId,
      routingPolicy,
    })
    .returning();
  return row!.id;
}

async function seedGroup(orgId: string): Promise<string> {
  const [group] = await db
    .insert(accountGroups)
    .values({
      orgId,
      name: `grp-${Math.random().toString(36).slice(2, 8)}`,
      platform: "openai",
    })
    .returning();
  return group!.id;
}

/**
 * Seed an upstream_accounts row + sealed credential_vault row. BYOK delta vs
 * the sibling tests: `userId` can be set so the upstream is OWNED by a user
 * (upstream_accounts.user_id). Pool upstreams pass userId=null. Optionally bind
 * the account to a pool group via account_group_members.
 */
async function seedAccount(
  orgId: string,
  plaintextCredential: string,
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
  groupId?: string,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-acct",
      platform: "openai",
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

  if (groupId) {
    await db
      .insert(accountGroupMembers)
      .values({ accountId: acct!.id, groupId, priority: 50 });
  }
  return acct!.id;
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeRedisMock(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

/**
 * Build the gateway app and force usage_logs persistence.
 *
 * In test mode `buildServer` leaves `usageLogQueue` undecorated, so
 * `emitUsageLog` returns before writing any row. We decorate a fake queue whose
 * `.add()` rejects: that drives `enqueueUsageLog`'s production INLINE DB
 * fallback (`writeUsageLogBatch`), persisting the real payload to usage_logs.
 */
async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  const app = await buildServer({ env, db, redis: redisMock });
  app.usageLogQueue = {
    add: () => Promise.reject(new Error("forced-enqueue-failure-for-test")),
  } as unknown as typeof app.usageLogQueue;
  return app;
}

/**
 * Poll for the single usage_logs row written by the request. usage_logs.request_id
 * is Fastify's internal req.id (not our X-Request-Id header), so we read the lone
 * row instead — `beforeEach` truncates usage_logs, so exactly one row is expected.
 * The inline DB write is awaited inside the route's `attempt` BEFORE the 200 is
 * sent, but we poll defensively in case of scheduler timing.
 */
async function waitForSingleUsageLog(): Promise<
  typeof usageLogs.$inferSelect
> {
  for (let i = 0; i < 50; i++) {
    const rows = await db.select().from(usageLogs);
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) {
      throw new Error(
        `expected exactly one usage_logs row, found ${rows.length}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("usage_logs row never appeared");
}

const chatPayload = {
  model: "gpt-4",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 50,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BYOK P1 end-to-end", () => {
  it("A. own-policy key → served by the caller's own upstream; usage_logs.accountId = own upstream, userId = caller", async () => {
    const orgId = await seedOrg();
    const userA = await seedUser();

    // User A OWNS this upstream (user_id = A).
    const ownAccountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-userA-own" }),
      { userId: userA, name: "userA-own" },
    );

    // own-policy key carries no group (BYOK); platform is derived from the
    // /v1/chat/completions surface (→ openai). routingPolicy "own" scopes the
    // scheduler to A's own upstreams (user_id = A).
    const rawKey = `ak_byok_own_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userA, rawKey, "own");

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: chatPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: "chat.completion" });

    const log = await waitForSingleUsageLog();
    // Served BY the caller's own upstream …
    expect(log.accountId).toBe(ownAccountId);
    // … and attributed to the caller.
    expect(log.userId).toBe(userA);

    await app.close();
  });

  it("B. second user's pool key never routes to user A's BYOK upstream", async () => {
    const orgId = await seedOrg();
    const userA = await seedUser();
    const userB = await seedUser();

    // User A's BYOK upstream — owned (user_id = A), must stay invisible to
    // pool requests.
    const aByokAccountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-userA-byok" }),
      { userId: userA, name: "userA-byok" },
    );

    // An openai pool group + a pool upstream (user_id = null) bound to it —
    // the only thing user B's pool key may reach. (A null-group pool key would
    // synthesize the legacy *anthropic* context and not match these openai
    // upstreams; binding B's key to an openai group keeps the platform aligned.)
    const groupId = await seedGroup(orgId);
    const poolAccountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-pool" }),
      { userId: null, name: "org-pool" },
      groupId,
    );

    // User B's key is a plain pool key bound to the openai pool group.
    const rawKeyB = `ak_pool_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userB, rawKeyB, "pool", groupId);

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKeyB}` },
      payload: chatPayload,
    });

    // Pool key is served (by the pool upstream) — not blocked, but ALSO never
    // served by A's BYOK upstream.
    expect(res.statusCode).toBe(200);

    const log = await waitForSingleUsageLog();
    // The crux: B can never reach A's credential.
    expect(log.accountId).not.toBe(aByokAccountId);
    // Positive assertion: it was the pool upstream that served B.
    expect(log.accountId).toBe(poolAccountId);
    expect(log.userId).toBe(userB);

    await app.close();
  });
});
