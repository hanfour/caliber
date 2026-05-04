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
import { encryptCredential, hashApiKey } from "@aide/gateway-core";
import {
  organizations,
  users,
  apiKeys,
  upstreamAccounts,
  credentialVault,
  accountGroups,
  type Database,
} from "@aide/db";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@aide/db/package.json")),
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
  /**
   * When set, the server writes SSE chunks (`data: {…}\n\n`) instead
   * of a single JSON body, with `content-type: text/event-stream`.
   * Each entry is one chunk written verbatim — caller can simulate
   * Anthropic's `event: message_start\ndata: {…}\n\n` frames.
   */
  sseChunks?: string[];
};
let lastUpstreamRequest: {
  url: string | undefined;
  method: string | undefined;
  body?: string;
} | null;

const defaultAnthropicResponse = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-3-haiku-20240307",
  content: [{ type: "text", text: "hi there" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 3 },
};

beforeAll(async () => {
  nextUpstreamResponse = {
    status: 200,
    body: JSON.stringify(defaultAnthropicResponse),
  };
  lastUpstreamRequest = null;

  fakeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      lastUpstreamRequest = { url: req.url, method: req.method, body };
      if (nextUpstreamResponse.closeSocket) {
        req.socket.destroy();
        return;
      }
      if (nextUpstreamResponse.sseChunks) {
        res.statusCode = nextUpstreamResponse.status;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        for (const c of nextUpstreamResponse.sseChunks) res.write(c);
        res.end();
        return;
      }
      res.statusCode = nextUpstreamResponse.status;
      res.setHeader("content-type", "application/json");
      res.end(nextUpstreamResponse.body);
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
  nextUpstreamResponse = {
    status: 200,
    body: JSON.stringify(defaultAnthropicResponse),
  };
  lastUpstreamRequest = null;
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
    // Same fake server handles both Anthropic and OpenAI Responses
    // upstream — the handler dispatches by `req.url` (`/v1/messages` vs
    // `/v1/responses`).
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
  return new RedisMock({ keyPrefix: "aide:gw:" }) as unknown as Redis;
}

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@aide/config");
  const env = parseServerEnv(buildEnv(connectionString));
  return buildServer({ env, db, redis: redisMock });
}

// ── Minimal valid OpenAI request payload ─────────────────────────────────────

const openaiPayload = {
  model: "gpt-4",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 50,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /v1/chat/completions", () => {
  it("1. happy path — translates OpenAI request, calls upstream, returns OpenAI response", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_happy_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: openaiPayload,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({
      id: "msg_test",
      object: "chat.completion",
      model: "claude-3-haiku-20240307",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi there" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    expect(typeof json.created).toBe("number");
    await app.close();
  });

  it("2. stream=true → SSE bytes translated to OpenAI Chat chunks + [DONE]", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_stream_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // Synthesize a minimal Anthropic SSE stream — message_start, one
    // text delta, content_block_stop, message_delta, message_stop.
    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream_1",
            model: "claude-3-haiku-20240307",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ],
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...openaiPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // Output contains the synthetic id from message_start.
    expect(body).toContain("msg_stream_1");
    // Output contains the translated text delta.
    expect(body).toContain('"content":"Hi"');
    // Output ends with the [DONE] sentinel.
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // The terminal chunk carries finish_reason stop + usage.
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"prompt_tokens":5');
    expect(body).toContain('"completion_tokens":1');

    // Verify the upstream request was sent with stream=true on the
    // translated Anthropic body.
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.stream).toBe(true);
    await app.close();
  });

  it("3. missing model → 400 missing_model", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_nomodel_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );
    lastUpstreamRequest = null;

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_model" });
    expect(lastUpstreamRequest).toBeNull(); // upstream not called
    await app.close();
  });

  it("4. empty body → 400 invalid_body", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_nobody_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    // Send a non-object body (null string) with content-type application/json
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      payload: "null",
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("5. translator failure → 400 invalid_request (malformed messages)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_badmsg_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    // Provide a tool call with invalid JSON arguments to trigger translator error
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "my_tool",
                  arguments: "NOT VALID JSON {{{",
                },
              },
            ],
          },
          { role: "user", content: "hello" },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    await app.close();
  });

  it("6. no eligible accounts → 503 all_upstreams_failed", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_noacct_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    // Seed only a soft-deleted account — should be excluded.
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-deleted" }),
      { deletedAt: new Date() },
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: openaiPayload,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "all_upstreams_failed" });
    await app.close();
  });

  it("7. failover: first account 429, second OK → returns OpenAI response from second", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_failover_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);

    // Seed two accounts so the failover loop has a second to switch to.
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-first-429" }),
    );
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-second-ok" }),
    );

    // First response is 429, second (after failover) is 200 with Anthropic body.
    let callCount = 0;
    const originalFakeServer = fakeServer;
    // Override response per-call using a mutable variable approach:
    // We'll set up a sequence via a counter on nextUpstreamResponse.
    // The fake server reads nextUpstreamResponse, so we stage a "first-429" scenario
    // by using a custom response queue.
    const responseQueue = [
      { status: 429, body: JSON.stringify({ error: "rate_limited" }) },
      {
        status: 200,
        body: JSON.stringify(defaultAnthropicResponse),
      },
    ];

    // Create a separate fake server for this test that serves from the queue.
    const seqServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const resp =
          responseQueue[callCount] ?? responseQueue[responseQueue.length - 1]!;
        callCount++;
        res.statusCode = resp.status;
        res.setHeader("content-type", "application/json");
        res.end(resp.body);
      });
    });
    await new Promise<void>((resolve) =>
      seqServer.listen(0, "127.0.0.1", resolve),
    );
    const seqAddr = seqServer.address() as AddressInfo;
    const seqBaseUrl = `http://127.0.0.1:${seqAddr.port}`;

    const { parseServerEnv } = await import("@aide/config");
    const env = parseServerEnv({
      ...buildEnv(container.getConnectionUri()),
      UPSTREAM_ANTHROPIC_BASE_URL: seqBaseUrl,
    });
    const redis = makeRedisMock();
    const app = await buildServer({ env, db, redis });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: openaiPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "msg_test",
      object: "chat.completion",
    });

    await app.close();
    await new Promise<void>((resolve) => seqServer.close(() => resolve()));
  });

  // Skipped: inline OAuth refresh on /v1/chat/completions is verified via
  // maybeRefreshOAuth unit/integration tests (oauthRefresh.integration.test.ts).
  // The route calls the identical maybeRefreshOAuth import as messages.ts — confirmed
  // by grep: chatCompletions.ts contains `await maybeRefreshOAuth(`.
  // A full end-to-end test here would require overriding the hardcoded DEFAULT_TOKEN_URL
  // (https://api.anthropic.com/oauth/token) which is not currently injectable via env;
  // adding an OAUTH_TOKEN_URL env override is tracked as a follow-up task.
  it.skip("inline OAuth refresh — verified via maybeRefreshOAuth unit/integration tests; route uses same code path as messages.ts (verified via grep)", () => {});

  it("8. fatal 4xx upstream → 4xx forwarded with request_id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const rawKey = `ak_oai_fatal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // 400 is classified as fatal by the classifier (client error).
    nextUpstreamResponse = {
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "bad request" },
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: openaiPayload,
    });

    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json).toHaveProperty("error");
    expect(json).toHaveProperty("request_id");
    await app.close();
  });

  // ── Plan 5A PR 9i — openai-platform branch (Chat ↔ Responses pivot) ────────

  it("9. openai-platform group + non-stream → Chat → Responses → Chat round trip", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_chat_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
    );

    // Upstream OpenAI Responses API responds with a Responses-shaped
    // body; the handler must translate it back to OpenAI Chat shape
    // (via the Anthropic intermediary).
    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_chat_oai_test",
        object: "response",
        created_at: 1700000000,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_chat_x",
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

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: openaiPayload,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Client sees an OpenAI Chat Completions-shaped response.
    expect(json).toMatchObject({
      object: "chat.completion",
    });
    expect(json.choices[0]).toMatchObject({
      message: { role: "assistant", content: "hello from openai" },
    });
    // Upstream POST went to /v1/responses (not /v1/messages).
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    await app.close();
  });

  it("10. openai-platform group + stream=true → Responses SSE translated to Chat chunks + [DONE]", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_chat_oai_strm_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_chat_strm_1", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_chat_1", role: "assistant" },
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
            id: "resp_chat_strm_1",
            status: "completed",
            incomplete_details: null,
            usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
          },
        })}\n\n`,
      ],
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...openaiPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // Chat-shaped chunks (data lines, not event-named) — the Chat
    // streaming format predates SSE event names.
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain("Hello world");
    // Terminal DONE marker is present.
    expect(body).toContain("data: [DONE]");
    // No raw OpenAI Responses event names leaked.
    expect(body).not.toContain("event: response.completed");
    expect(body).not.toContain("event: response.output_text.delta");
    // Upstream got stream=true and was POSTed to /v1/responses.
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.stream).toBe(true);
    await app.close();
  });

  it("11. openai-platform group + stream=true with malformed mid-stream event → continues (lenient)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser(orgId);
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_chat_oai_strm_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      { platform: "openai" },
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_chat_mal", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        // Single malformed event in the middle.
        `event: response.output_text.delta\ndata: not-json-at-all\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_chat_mal",
            status: "completed",
            incomplete_details: null,
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          },
        })}\n\n`,
      ],
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...openaiPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Surrounding events translate; final [DONE] terminator still emitted.
    expect(body).toContain("data: [DONE]");
    // The malformed payload was dropped, not echoed verbatim.
    expect(body).not.toContain("not-json-at-all");
    await app.close();
  });
});
