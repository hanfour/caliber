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
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

// ── Fake upstream (OpenAI Responses) HTTP server ────────────────────────────
//
// Echoes back the `model` field it received on the request body so the test
// can assert the alias was resolved BEFORE the body was forwarded upstream,
// in an OpenAI Responses-shaped 200 with a usage block.

let fakeServer: Server;
let fakeBaseUrl: string;
/** The `model` field the fake upstream saw on the last request body. */
let receivedModel: string | null;

beforeAll(async () => {
  receivedModel = null;
  fakeServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      let model: string | null = null;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        model = typeof parsed.model === "string" ? parsed.model : null;
      } catch {
        model = null;
      }
      receivedModel = model;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_alias_echo",
          object: "response",
          created_at: 1700000000,
          model: model ?? "unknown",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_alias_1",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "ok", annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
          incomplete_details: null,
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

beforeEach(() => {
  receivedModel = null;
});

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// The OpenAI bucket baseUrl the resolution + registry lookup key on — must be
// the exact `UPSTREAM_OPENAI_BASE_URL` the route passes to applyModelResolution.
let openaiBaseUrl: string;

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
    UPSTREAM_OPENAI_BASE_URL: fakeBaseUrl,
    // Turn the model-alias resolver ON for this suite.
    GATEWAY_ENABLE_MODEL_ALIAS: "true",
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

async function seedKey(
  orgId: string,
  userId: string,
  rawKey: string,
  groupId: string,
): Promise<void> {
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-key-openai",
    groupId,
  });
}

/**
 * Seed a single pool api_key OpenAI upstream + its credential, bound to the
 * group. One account → one credential type → single bucket → cacheable
 * up-front resolution path.
 */
async function seedGroupApiKeyAccount(
  orgId: string,
  groupId: string,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "openai-apikey-acct",
      platform: "openai",
      type: "api_key",
      schedulable: true,
      status: "active",
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });

  await db
    .insert(accountGroupMembers)
    .values({ accountId: acct!.id, groupId, priority: 50 });

  return acct!.id;
}

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  openaiBaseUrl = env.UPSTREAM_OPENAI_BASE_URL;
  const app = await buildServer({ env, db, redis: redisMock });
  // Seed the OpenAI api_key bucket directly so `gpt-5` resolves
  // deterministically (the static fallback ships gpt-5.4 / gpt-5.4-mini,
  // which do NOT contain a `gpt-5-` prefixed member). The newest member
  // `gpt-5-2025-10-01` wins; `gpt-5-mini` is excluded by the conservative
  // OpenAI family matcher.
  app.modelRegistry.set(
    {
      platform: "openai",
      baseUrl: openaiBaseUrl,
      credentialType: "api_key",
    },
    [
      { id: "gpt-5-2025-10-01", created: 1_700_000_000 },
      { id: "gpt-5-mini", created: 1_700_000_001 },
    ],
  );
  // The injected-redis (test) path skips BullMQ, so `app.usageLogQueue` is
  // undefined and emitUsageLog no-ops. Decorate a stub queue whose `add`
  // rejects → `enqueueUsageLog` writes the row inline to the DB via its
  // fallback, letting us assert the persisted requested/upstream model.
  (app as unknown as { usageLogQueue: unknown }).usageLogQueue = {
    add: () => Promise.reject(new Error("stub: force inline DB fallback")),
  };
  return app;
}

// ── Test ──────────────────────────────────────────────────────────────────────

const RESOLVED = "gpt-5-2025-10-01";

describe("POST /v1/responses (openai passthrough) — model alias resolution", () => {
  it("resolves `gpt-5` to the newest gpt-5 id, sets the header, and logs alias→resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_oai_alias_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);
    await seedGroupApiKeyAccount(orgId, groupId);

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "gpt-5",
        input: "hi",
        max_output_tokens: 8,
      },
    });

    expect(res.statusCode).toBe(200);
    // 1. The fake upstream received the resolved (concrete) model id, NOT the alias.
    expect(receivedModel).toBe(RESOLVED);
    // 2. The resolved model is echoed back to the caller via a response header.
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    // 3. The usage_logs row records the alias as requested_model and the
    //    resolved id as upstream_model. Allow the fire-and-forget emit to flush.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db
      .select({
        requestedModel: usageLogs.requestedModel,
        upstreamModel: usageLogs.upstreamModel,
      })
      .from(usageLogs)
      .where(and(eq(usageLogs.orgId, orgId), eq(usageLogs.userId, userId)));

    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe("gpt-5");
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });
});
