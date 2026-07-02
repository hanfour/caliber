import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  type Database,
} from "@caliber/db";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

// ── §4.1 existence-vs-schedulability split (BYOK Task 13) ────────────────────
//
// When `routing_policy = "own"` and the scheduler finds NO schedulable
// candidate, the response must distinguish two cases:
//   * NO own upstream registered at all for the surface platform → CLEAN 409
//     `no_own_upstream` (keyed off a SEPARATE unfiltered existence SELECT).
//   * An own upstream EXISTS but is unschedulable (paused / not active /
//     rate-limited / overloaded) → the EXISTING transient 503 path, unchanged.
//
// `own_then_pool` and `pool` keys are UNAFFECTED — only bare `own` 409s.

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

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

// ── Fake upstream (never expected to be hit on these paths) ──────────────────

let fakeServer: Server;
let fakeBaseUrl: string;

beforeAll(async () => {
  fakeServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
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

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

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

async function seedOwnApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<void> {
  // A non-pool ("own") BYOK key: groupId MUST be null (routing_policy_group_mutex
  // check) and routing_policy = "own".
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-own-key",
    groupId: null,
    routingPolicy: "own",
  });
}

async function seedOwnThenPoolApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<void> {
  // An `own_then_pool` key: groupId MUST be null, routing_policy = "own_then_pool".
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-own-then-pool-key",
    groupId: null,
    routingPolicy: "own_then_pool",
  });
}

async function seedOwnAccount(
  orgId: string,
  userId: string,
  plaintextCredential: string,
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      userId,
      name: "test-own-acct",
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

function makeRedisMock(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  return buildServer({ env, db, redis: redisMock });
}

// /v1/messages is the anthropic surface — the simplest path for an
// anthropic-platform own key.
const anthropicPayload = {
  model: "claude-3-haiku-20240307",
  max_tokens: 50,
  messages: [{ role: "user", content: "hello" }],
};

describe("BYOK own policy — 409 no_own_upstream vs 503 (existence split)", () => {
  it("own key with NO own upstream registered for the platform → 409 no_own_upstream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_own_none_${Math.random().toString(36).slice(2)}`;
    await seedOwnApiKey(orgId, userId, rawKey);
    // No own upstream seeded at all for this user.

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: anthropicPayload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "no_own_upstream" });
    } finally {
      await app.close();
    }
  });

  it("own key whose own upstream EXISTS but is unschedulable → 503 (NOT 409)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_own_unsched_${Math.random().toString(36).slice(2)}`;
    await seedOwnApiKey(orgId, userId, rawKey);
    // The user HAS an own upstream — but it is not schedulable, so the
    // filtered candidate set is empty even though a credential exists.
    await seedOwnAccount(
      orgId,
      userId,
      JSON.stringify({ type: "api_key", api_key: "sk-own-unsched" }),
      { schedulable: false },
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: anthropicPayload,
      });

      expect(res.statusCode).toBe(503);
      const json = res.json();
      // The existing transient/no-schedulable path — NOT the 409 existence
      // error. (/v1/messages emits `no_upstream_available` when the filtered
      // candidate set is empty; the key point is it is 503, not 409.)
      expect(json.error).not.toBe("no_own_upstream");
      expect(json).toMatchObject({ error: "no_upstream_available" });
    } finally {
      await app.close();
    }
  });

  it("own key whose own upstream EXISTS but is soft-deleted → 409 (deleted is not 'registered')", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_own_deleted_${Math.random().toString(36).slice(2)}`;
    await seedOwnApiKey(orgId, userId, rawKey);
    // Only a soft-deleted own upstream — the existence check ignores
    // schedulability filters but MUST still respect deletedAt.
    await seedOwnAccount(
      orgId,
      userId,
      JSON.stringify({ type: "api_key", api_key: "sk-own-deleted" }),
      { deletedAt: new Date() },
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: anthropicPayload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "no_own_upstream" });
    } finally {
      await app.close();
    }
  });

  it("own_then_pool key with NO own upstream and NO pool upstream → 503 (NOT 409)", async () => {
    // §4.1 NEGATIVE: `own_then_pool` routing_policy MUST NOT trigger the
    // `no_own_upstream` 409 even when the user has zero own upstreams.
    // The policy's fallback path to pool means the absence of an own upstream
    // is NOT an existence error — it's a transient 503 (no candidates at all).
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_otp_none_${Math.random().toString(36).slice(2)}`;
    await seedOwnThenPoolApiKey(orgId, userId, rawKey);
    // No own upstream AND no pool upstream for this org → scheduler has zero
    // candidates → transient 503, not the existence-check 409.

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: anthropicPayload,
      });

      // Must be 503 (no candidates), NOT 409 (no_own_upstream).
      // own_then_pool never emits no_own_upstream regardless of own-upstream
      // presence — the 409 gate is strictly for bare "own" policy keys.
      expect(res.statusCode).toBe(503);
      expect(res.json().error).not.toBe("no_own_upstream");
    } finally {
      await app.close();
    }
  });
});
