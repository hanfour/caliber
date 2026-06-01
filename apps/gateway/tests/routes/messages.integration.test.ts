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
  type Database,
} from "@caliber/db";
import { acquireSlot } from "../../src/redis/slots.js";
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

// ── Fake upstream (Anthropic) HTTP server ────────────────────────────────────

let fakeServer: Server;
let fakeBaseUrl: string;
let nextUpstreamResponse: {
  status: number;
  body: string;
  closeSocket?: boolean;
  /** When set, respond as SSE: write these chunks then end. */
  sseChunks?: string[];
};
let lastRequest: { url: string | undefined; method: string | undefined } | null;

beforeAll(async () => {
  nextUpstreamResponse = {
    status: 200,
    body: '{"id":"msg_default","content":[]}',
  };
  lastRequest = null;
  fakeServer = createServer((req, res) => {
    lastRequest = { url: req.url, method: req.method };
    if (nextUpstreamResponse.closeSocket) {
      req.socket.destroy();
      return;
    }
    if (nextUpstreamResponse.sseChunks) {
      res.statusCode = nextUpstreamResponse.status;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      for (const chunk of nextUpstreamResponse.sseChunks) {
        res.write(chunk);
      }
      res.end();
      return;
    }
    res.statusCode = nextUpstreamResponse.status;
    res.setHeader("content-type", "application/json");
    res.end(nextUpstreamResponse.body);
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
  nextUpstreamResponse = {
    status: 200,
    body: '{"id":"msg_default","content":[]}',
  };
  lastRequest = null;
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
    // Same fake server handles both /v1/messages (anthropic) and
    // /v1/responses (openai) — the handler inspects req.url.
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

async function seedUser(orgId: string): Promise<string> {
  const email = `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const [user] = await db.insert(users).values({ email }).returning();
  return user!.id;
}

async function seedApiKey(
  orgId: string,
  userId: string,
  rawKey: string,
  groupId: string | null = null,
): Promise<void> {
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-key",
    groupId,
  });
}

async function seedGroup(
  orgId: string,
  platform: "anthropic" | "openai" = "openai",
): Promise<string> {
  const [group] = await db
    .insert(accountGroups)
    .values({
      orgId,
      name: `grp-${Math.random().toString(36).slice(2, 8)}`,
      platform,
    })
    .returning();
  return group!.id;
}

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

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  return buildServer({ env, db, redis: redisMock });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /v1/messages", () => {
  it("1. happy path — forwards 200 + upstream body", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_happy_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = { status: 200, body: '{"id":"msg_x","content":[]}' };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "msg_x" });
    await app.close();
  });

  it("2. stream=true returns 200 SSE text/event-stream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_stream_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // Fake upstream streams SSE chunks.
    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: ['event: ping\ndata: {"type":"ping"}\n\n'],
    };

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

    // inject collects the full SSE body; status should be 200.
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body).toContain("event: ping");
    await app.close();
  });

  it("3. no eligible accounts → 503 no_upstream_available", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_noacct_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    // Seed account with deleted_at set — should be excluded by selectAccountIds.
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-deleted" }),
      { deletedAt: new Date() },
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "no_upstream_available" });
    await app.close();
  });

  it("4. upstream 4xx is forwarded to caller", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_4xx_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}',
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: "error" });
    await app.close();
  });

  it("5. account at capacity → 503 (failover exhausted with no other accounts)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_cap_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
      { concurrency: 2 },
    );

    const redis = makeRedisMock();

    // Pre-fill the ZSET to capacity using the same acquireSlot helper.
    const filled1 = await acquireSlot(
      redis,
      "account",
      accountId,
      "req-fill-1",
      2,
      60_000,
    );
    const filled2 = await acquireSlot(
      redis,
      "account",
      accountId,
      "req-fill-2",
      2,
      60_000,
    );
    expect(filled1).toBe(true);
    expect(filled2).toBe(true);

    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(503);
    // With the failover loop, the at-capacity account is treated as transient;
    // since there is only one account, the loop exhausts and returns all_upstreams_failed.
    expect(res.json()).toMatchObject({ error: "all_upstreams_failed" });
    await app.close();
  });

  it("6. slot is released after successful request", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_release_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: '{"id":"msg_rel","content":[]}',
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(200);

    // After the request, the slot ZSET should be empty (ZCARD = 0).
    const slotKey = `slots:account:${accountId}`;
    const count = await redis.zcard(slotKey);
    expect(count).toBe(0);

    await app.close();
  });

  it("7. slot is released even when upstream closes socket (error path)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_err_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    const accountId = await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // Make upstream destroy the socket to simulate a network error.
    nextUpstreamResponse = { status: 200, body: "", closeSocket: true };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    // The inject call may throw or return a 500; either is acceptable.
    const res = await app
      .inject({
        method: "POST",
        url: "/v1/messages",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
      })
      .catch(() => null);

    // Regardless of outcome, the slot must have been released.
    const slotKey = `slots:account:${accountId}`;
    const count = await redis.zcard(slotKey);
    expect(count).toBe(0);

    // Cleanup — may already be closed due to error.
    await app.close().catch(() => {
      /* already closed */
    });
  });

  it("8. missing api key → 401 (auth middleware, not route)", async () => {
    const orgId = await seedOrg();
    await seedUser(orgId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "claude-3-haiku-20240307", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "missing_api_key" });
    await app.close();
  });

  it("9. returns 400 missing_model when model field absent", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_nomodel_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );
    lastRequest = null; // reset upstream tracker

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {}, // no model field
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_model" });
    expect(lastRequest).toBeNull(); // upstream not called
    await app.close();
  });

  it("10. returns 413 when body exceeds GATEWAY_MAX_BODY_BYTES", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_413_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // Override env with tiny body limit so a small payload trips it.
    const { parseServerEnv } = await import("@caliber/config");
    const tinyEnv = parseServerEnv({
      ...buildEnv(container.getConnectionUri()),
      GATEWAY_MAX_BODY_BYTES: "1024",
    });
    const redis = makeRedisMock();
    const app = await buildServer({ env: tinyEnv, db, redis });

    const oversized = { model: "claude-3", junk: "x".repeat(2048) };
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: oversized,
    });

    expect(res.statusCode).toBe(413);
    await app.close();
  });

  // ── PR 9g: openai-platform branch (cross-format /v1/messages) ──────────────

  it("openai-platform group → translates Anthropic body to OpenAI Responses, calls openai upstream, translates back", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    // Upstream OpenAI Responses API responds with a Responses-shaped
    // body; our handler must translate it back to Anthropic shape.
    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_msg_oai_test",
        object: "response",
        created_at: 1700000000,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_xx",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "hello from openai",
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        incomplete_details: null,
      }),
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 50,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Client sees an Anthropic Messages-shaped response.
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
    });
    expect(json.content[0]).toMatchObject({
      type: "text",
      text: "hello from openai",
    });
    // Stop reason translated from Responses status.
    expect(json.stop_reason).toBe("end_turn");
    // Upstream POST went to /v1/responses (not /v1/messages).
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe("/v1/responses");
    await app.close();
  });

  it("openai-platform group + tool_use upstream → Anthropic tool_use content block", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_tool_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_tool",
        object: "response",
        created_at: 1700000000,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "tu_x",
            call_id: "tu_x",
            name: "lookup",
            arguments: JSON.stringify({ q: "weather" }),
            status: "completed",
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        incomplete_details: null,
      }),
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "what's the weather?" }],
        max_tokens: 50,
        tools: [
          {
            name: "lookup",
            description: "Look something up",
            input_schema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.stop_reason).toBe("tool_use");
    const toolUse = json.content.find(
      (b: { type: string }) => b.type === "tool_use",
    );
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "tu_x",
      name: "lookup",
      input: { q: "weather" },
    });
    await app.close();
  });

  it("openai-platform group + stream=true → Responses SSE translated to Anthropic SSE", async () => {
    // PR 9h cross-format streaming. The same upstream wire bytes from
    // PR 9e's `7c.` test get translated through the inverse direction
    // (Responses → Anthropic) and emerge as Anthropic-shaped SSE.
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_strm_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_msg_strm_1", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_oai_1", role: "assistant" },
        })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Hello world",
        })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_msg_strm_1",
            status: "completed",
            incomplete_details: null,
            usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
          },
        })}\n\n`,
      ],
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // Anthropic SSE shape — translator emits these named events.
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: content_block_stop");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
    // The text delta survives translation.
    expect(body).toContain("Hello world");
    // No raw OpenAI-shaped events leaked through.
    expect(body).not.toContain("event: response.completed");
    expect(body).not.toContain("event: response.output_text.delta");
    // Upstream got stream=true and was POSTed to /v1/responses.
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe("/v1/responses");
    await app.close();
  });

  it("openai-platform group + stream=true with malformed mid-stream event → continues (lenient)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_strm_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_mal_msg", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        // Single malformed event in the middle.
        `event: response.output_text.delta\ndata: not-json-at-all\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_mal_msg",
            status: "completed",
            incomplete_details: null,
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          },
        })}\n\n`,
      ],
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Surrounding events translated through despite the malformed one.
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: message_stop");
    // The malformed payload was dropped, not echoed verbatim.
    expect(body).not.toContain("not-json-at-all");
    await app.close();
  });

  it("openai-platform group + stream=true truncated before response.completed → partial events delivered", async () => {
    // Upstream closes mid-stream without emitting response.completed.
    // The parser exits cleanly; whatever events did arrive get
    // translated, and the usage_log row is filled with null
    // (zero-cost forensic entry).
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_strm_trunc_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_msg_trunc", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_oai_t", role: "assistant" },
        })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "hi",
        })}\n\n`,
        // No response.completed — upstream truncates here.
      ],
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"text":"hi"');
    // Translator's onEnd() emits the closing terminators even though
    // upstream never sent response.completed, so the client-side
    // Anthropic SDK reader sees a clean termination.
    expect(body).toContain("event: message_stop");
    await app.close();
  });

  it("autoRoute defaults to anthropic when group ctx is null (legacy 4A behaviour preserved)", async () => {
    // Legacy api keys (no group_id) get a synthetic anthropic context
    // from groupContextPlugin. autoRoute hits the existing 4A handler.
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_msg_legacy_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, null);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-ant-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "msg_legacy",
        type: "message",
        role: "assistant",
        model: "claude-3-haiku-20240307",
        content: [{ type: "text", text: "legacy still works" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    };

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content[0].text).toBe("legacy still works");
    // Upstream went to /v1/messages (anthropic), NOT /v1/responses.
    expect(lastRequest!.url).toBe("/v1/messages");
    await app.close();
  });

  it("openai-platform group + upstream 503 with one account → 503 all_upstreams_failed", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_5xx_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );
    nextUpstreamResponse = {
      status: 503,
      body: JSON.stringify({ error: { message: "Service unavailable" } }),
    };
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "all_upstreams_failed" });
    await app.close();
  });

  it("openai-platform group + upstream 401 → switch_account → AllUpstreamsFailed → 503", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_4xx_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );
    nextUpstreamResponse = {
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key" } }),
    };
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      },
    });
    // 401 is `switch_account` per the failover classifier; with one
    // account in the pool, the pool exhausts → AllUpstreamsFailed.
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("all_upstreams_failed");
    await app.close();
  });

  it("openai-platform group + upstream 200 with malformed JSON → 502 / 503 forensic path", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );
    nextUpstreamResponse = {
      status: 200,
      body: "not valid json {",
    };
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      },
    });
    // The handler throws { status: 502 } inside attempt; with one
    // account, failover surfaces AllUpstreamsFailed → 503.
    expect([502, 503]).toContain(res.statusCode);
    await app.close();
  });

  it("openai-platform + Anthropic system prompt → translates to instructions → comes back as Anthropic", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_msg_oai_sys_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );
    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_sys",
        object: "response",
        created_at: 1700000000,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_sys",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "ok terse", annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        incomplete_details: null,
      }),
    };
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const { parseServerEnv } = await import("@caliber/config");
    const env = parseServerEnv(buildEnv(container.getConnectionUri()));
    const app = await buildServer({ env, db, redis });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-3-haiku-20240307",
        system: "be terse",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 50,
      },
    });
    expect(res.statusCode).toBe(200);
    // End-to-end shape assertion: client gets Anthropic Messages
    // shape back with the translated content. The system → instructions
    // round-trip is unit-tested in gateway-core; this confirms the
    // wiring works end-to-end with the `system` field present.
    expect(res.json()).toMatchObject({
      type: "message",
      role: "assistant",
    });
    expect(res.json().content[0].text).toBe("ok terse");
    await app.close();
  });

  // ── Idempotency cache (design §4.5) — client-opt-in via X-Request-Id ───────

  it("idempotency: anthropic handler replays a 200 on a repeated X-Request-Id without re-dispatching upstream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_idem_anth_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: '{"id":"msg_idem_anth","content":[]}',
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const reqId = `rid-anth-${Math.random().toString(36).slice(2)}`;
    const payload = { model: "claude-3-haiku-20240307", max_tokens: 10 };

    // First call: cache miss → upstream dispatched, response stored.
    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: "msg_idem_anth" });
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();

    // Let the fire-and-forget storeIdempotent write flush.
    await new Promise((r) => setTimeout(r, 20));

    // Stage the upstream to FAIL and clear the request tracker: a true replay
    // must short-circuit before any upstream dispatch.
    nextUpstreamResponse = { status: 500, body: "SHOULD_NOT_BE_CALLED" };
    lastRequest = null;

    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: "msg_idem_anth" });
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(lastRequest).toBeNull(); // upstream never touched on replay
    await app.close();
  });

  it("idempotency: openai-platform messages handler replays a 200 on a repeated X-Request-Id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_idem_msg_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
      groupId,
    );

    const openaiBody = JSON.stringify({
      id: "resp_idem_msg_oai",
      object: "response",
      created_at: 1700000000,
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_idem",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "hello from openai", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      incomplete_details: null,
    });
    nextUpstreamResponse = { status: 200, body: openaiBody };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const reqId = `rid-msg-oai-${Math.random().toString(36).slice(2)}`;
    const payload = {
      model: "claude-3-haiku-20240307",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 50,
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().content[0]).toMatchObject({ text: "hello from openai" });
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();

    await new Promise((r) => setTimeout(r, 20));
    nextUpstreamResponse = { status: 500, body: "SHOULD_NOT_BE_CALLED" };
    lastRequest = null;

    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().content[0]).toMatchObject({ text: "hello from openai" });
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(lastRequest).toBeNull();
    await app.close();
  });
});
