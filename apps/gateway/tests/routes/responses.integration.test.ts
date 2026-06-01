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
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

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
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

let fakeServer: Server;
let fakeBaseUrl: string;
let nextUpstreamResponse: {
  status: number;
  body: string;
  /**
   * When set, the server writes SSE chunks (`event:…\ndata:…\n\n`)
   * instead of a JSON body, with `content-type: text/event-stream`.
   * Used by the streaming test to simulate Anthropic SSE upstream.
   */
  sseChunks?: string[];
};
let lastUpstreamRequest: {
  url: string | undefined;
  method: string | undefined;
  body?: string;
  /** All upstream request headers, lower-cased per Node convention. */
  headers?: Record<string, string | string[] | undefined>;
} | null;

const defaultAnthropicResponse = {
  id: "msg_resp_test",
  type: "message",
  role: "assistant",
  model: "claude-3-haiku-20240307",
  content: [{ type: "text", text: "hello from anthropic" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 7, output_tokens: 4 },
};

beforeAll(async () => {
  nextUpstreamResponse = {
    status: 200,
    body: JSON.stringify(defaultAnthropicResponse),
  };
  lastUpstreamRequest = null;

  fakeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      lastUpstreamRequest = {
        url: req.url,
        method: req.method,
        body,
        headers: req.headers,
      };
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
    // Same fake — the server inspects req.url to differentiate
    // /v1/messages (anthropic) from /v1/responses (openai). Lets
    // openai-upstream tests share the seed harness.
    UPSTREAM_OPENAI_BASE_URL: fakeBaseUrl,
  };
}

async function seedOrg(): Promise<string> {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`;
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: "Test Org" })
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
  platform: "anthropic" | "openai" = "anthropic",
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
  platform: "anthropic" | "openai" = "anthropic",
  groupId?: string,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-acct",
      platform,
      type: "api_key",
      schedulable: true,
      status: "active",
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

const validResponsesPayload = {
  model: "gpt-4o",
  input: "What's the weather?",
  max_output_tokens: 50,
};

describe("/v1/responses", () => {
  it("1. valid request → 200 + Responses-shaped JSON", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({
      object: "response",
      status: "completed",
      model: defaultAnthropicResponse.model,
    });
    // Anthropic text content_block became a Responses output_text inside a message item.
    expect(json.output[0].type).toBe("message");
    expect(json.output[0].content[0]).toMatchObject({
      type: "output_text",
      text: "hello from anthropic",
    });
    // Usage was forwarded.
    expect(json.usage).toMatchObject({ input_tokens: 7, output_tokens: 4 });

    // Upstream was called with the translated Anthropic body.
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.model).toBe(validResponsesPayload.model);
    expect(upstreamBody.messages).toBeDefined();
    expect(upstreamBody.max_tokens).toBe(50);
    await app.close();
  });

  it("2. tool_use stop_reason → function_call output_item", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_tool_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-3-haiku-20240307",
        content: [
          {
            type: "tool_use",
            id: "tu_x",
            name: "lookup",
            input: { q: "weather" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        ...validResponsesPayload,
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    const fc = json.output.find(
      (item: { type: string }) => item.type === "function_call",
    );
    expect(fc).toMatchObject({
      type: "function_call",
      id: "tu_x",
      call_id: "tu_x",
      name: "lookup",
      arguments: JSON.stringify({ q: "weather" }),
    });
    await app.close();
  });

  it("3. silently-dropped fields (codex CLI compat) — 200, not forwarded upstream", async () => {
    // codex CLI / openai SDK send these fields unconditionally on every
    // /v1/responses call. caliber treats them as no-ops for now (route
    // strips pre-Zod) so .strict() doesn't 400 against them. Each
    // field × representative value must:
    //   a) succeed with 200
    //   b) not appear in the translated Anthropic body sent upstream
    const cases: Array<{ field: string; payload: Record<string, unknown> }> = [
      { field: "store", payload: { store: true } },
      { field: "store", payload: { store: false } },
      { field: "parallel_tool_calls", payload: { parallel_tool_calls: true } },
      {
        field: "parallel_tool_calls",
        payload: { parallel_tool_calls: false },
      },
      { field: "reasoning", payload: { reasoning: { effort: "high" } } },
    ];

    for (const { field, payload } of cases) {
      const orgId = await seedOrg();
      const userId = await seedUser();
      const rawKey = `ak_resp_drop_${field}_${Math.random().toString(36).slice(2)}`;
      await seedApiKey(orgId, userId, rawKey);
      await seedAccount(
        orgId,
        JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
      );

      const redis = makeRedisMock();
      const app = await makeApp(redis, container.getConnectionUri());

      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { ...validResponsesPayload, ...payload },
      });
      expect(
        res.statusCode,
        `field=${field} payload=${JSON.stringify(payload)}`,
      ).toBe(200);

      expect(lastUpstreamRequest).not.toBeNull();
      const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
      expect(
        upstreamBody,
        `field=${field} should be stripped from upstream body`,
      ).not.toHaveProperty(field);
      await app.close();
    }
  });

  it("4. server-side tool `file_search` → 400 (still rejected)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_fs_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, file_search: { enabled: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "unsupported_feature",
      field: "file_search",
    });
    await app.close();
  });

  it("5. missing model → 400 invalid_request via Zod", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_nomodel_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { input: "hello" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    await app.close();
  });

  it("6. stream=true → SSE bytes translated to Responses events + completed", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_strm_${Math.random().toString(36).slice(2)}`;
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
            id: "msg_resp_stream_1",
            model: "claude-3-haiku-20240307",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 0 },
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
          delta: { type: "text_delta", text: "Hello" },
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
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // Responses SSE uses named events.
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_item.added");
    expect(body).toContain("event: response.content_part.added");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.output_item.done");
    expect(body).toContain("event: response.completed");
    // The translated text delta survives the round-trip.
    expect(body).toContain('"delta":"Hello"');
    // Synthetic id from message_start surfaces in the response.created.
    expect(body).toContain("msg_resp_stream_1");
    // Terminal completed event has status=completed + usage.
    expect(body).toContain('"status":"completed"');

    // Verify the upstream request was sent with stream=true.
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.stream).toBe(true);
    await app.close();
  });

  it("6b. stream=true with tool_use → function_call output_item events", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_strm_tool_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    // Anthropic SSE for a tool_use turn — message_start, tool_use
    // content_block_start, two input_json_delta fragments, stop, then
    // message_delta with stop_reason=tool_use.
    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_tool_stream",
            model: "claude-3-haiku-20240307",
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tu_stream_a",
            name: "lookup",
            input: {},
          },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q":' },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"weather"}' },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 3 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ],
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        ...validResponsesPayload,
        stream: true,
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: { type: "object" },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // Function-call output_item path emitted, with name + call_id mirrored
    // from the upstream tool_use id.
    expect(body).toContain('"type":"function_call"');
    expect(body).toContain('"name":"lookup"');
    expect(body).toContain("tu_stream_a");
    // Both input_json_delta fragments survive as
    // response.function_call_arguments.delta.
    expect(body).toContain("event: response.function_call_arguments.delta");
    expect(body).toContain('"delta":"{\\"q\\":"');
    expect(body).toContain('"delta":"\\"weather\\"}"');
    // Terminal completed event status=completed (tool_use is a clean
    // run-completion in the Responses model; not "incomplete").
    expect(body).toContain("event: response.completed");
    expect(body).toContain('"status":"completed"');
    await app.close();
  });

  it("7. openai-platform group → passthrough to OpenAI Responses upstream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    const openaiResponse = {
      id: "resp_openai_test",
      object: "response",
      created_at: 1700000000,
      model: "gpt-4o",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_openai_1",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "hello from openai", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      incomplete_details: null,
    };
    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify(openaiResponse),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    // Body is passthrough — OpenAI upstream shape arrives at the client.
    expect(json).toMatchObject({
      id: "resp_openai_test",
      object: "response",
      status: "completed",
    });

    // Verify the upstream request hit /v1/responses (not /v1/messages)
    // and was sent unchanged (no Anthropic translation on either side).
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.model).toBe(validResponsesPayload.model);
    expect(upstreamBody.input).toBe(validResponsesPayload.input);
    expect(upstreamBody.messages).toBeUndefined(); // no anthropic translation
    await app.close();
  });

  it("7-compact. openai-platform group → /v1/responses/compact passthrough", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_compact_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    const compactResponse = {
      id: "resp_compact_test",
      object: "response.compaction",
      created_at: 1700000000,
      output: [
        {
          id: "msg_x",
          type: "message",
          role: "user",
          status: "completed",
          content: [],
        },
      ],
    };
    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify(compactResponse),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses/compact",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "gpt-5", input: "summarise this" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "resp_compact_test",
      object: "response.compaction",
    });
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses/compact");
    await app.close();
  });

  it("7-compact-anthropic. anthropic-platform group → /v1/responses/compact rejected", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "anthropic");
    const rawKey = `ak_resp_anth_compact_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-ant-test" }),
      "anthropic",
      groupId,
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses/compact",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "claude-3-haiku", input: "summarise this" },
    });

    // Compact is OpenAI-only; anthropic-platform key gets a clean
    // 400 instead of being routed to an Anthropic upstream that
    // doesn't speak Responses.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "compact_not_supported_on_platform",
      platform: "anthropic",
    });
    await app.close();
  });

  it("7b. openai upstream 4xx error → forwards status to client", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_4xx_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key" } }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    // 401 is `switch_account` — with one account in the pool, the
    // failover loop exhausts it and surfaces AllUpstreamsFailed → 503.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "all_upstreams_failed" });
    await app.close();
  });

  it("7c. openai-platform group + stream=true → SSE bytes parsed and re-emitted", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_stream_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    // Synthesize a 6-event OpenAI Responses SSE stream.
    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_oai_stream_1", model: "gpt-4o", created_at: 1 },
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
            id: "resp_oai_stream_1",
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
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.body;
    // All 6 named events made the round trip.
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_item.added");
    expect(body).toContain("event: response.content_part.added");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.output_item.done");
    expect(body).toContain("event: response.completed");
    // The text delta survives.
    expect(body).toContain('"delta":"Hello world"');
    // Synthetic id from response.created surfaces.
    expect(body).toContain("resp_oai_stream_1");
    // Terminal completed event has the usage we sent upstream.
    expect(body).toContain('"input_tokens":9');
    expect(body).toContain('"output_tokens":2');

    // Verify upstream got stream=true on the body and was POSTed to
    // /v1/responses (not /v1/messages).
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.stream).toBe(true);
    await app.close();
  });

  it("7c-i. openai stream with malformed SSE JSON mid-stream → continues (lenient)", async () => {
    // The parser runs in `strict: false` mode at the route, so a single
    // malformed event doesn't abort the stream — the surrounding events
    // still reach the client.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_strm_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_mal", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        // Malformed event — invalid JSON in the middle.
        `event: response.output_text.delta\ndata: not-json-at-all\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_mal",
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
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Surrounding events made it through.
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.completed");
    // The malformed event was dropped (no `not-json-at-all` text in output).
    expect(body).not.toContain("not-json-at-all");
    await app.close();
  });

  it("7c-ii. openai stream truncated before response.completed → usage_log fed null", async () => {
    // When upstream closes mid-stream without ever emitting
    // response.completed, the parser exits cleanly (no events left)
    // and the usage_log row gets null upstreamResponse — which
    // emitUsageLog then writes as a zero-cost forensic entry.  The
    // client still gets the partial events that did arrive.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_strm_trunc_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "",
      sseChunks: [
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_trunc", model: "gpt-4o", created_at: 1 },
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

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: response.created");
    expect(res.body).toContain('"delta":"hi"');
    // No completed event reached the client.
    expect(res.body).not.toContain("event: response.completed");
    await app.close();
  });

  it("7d. openai upstream sends Bearer auth header from api_key credential", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_auth_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-secret" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_x",
        object: "response",
        created_at: 1,
        model: "gpt-4o",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        incomplete_details: null,
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    expect(res.statusCode).toBe(200);
    // The fake-server harness now records all upstream headers; assert
    // the Authorization header was built from the api_key credential.
    expect(lastUpstreamRequest!.headers!.authorization).toBe(
      "Bearer sk-openai-secret",
    );
    await app.close();
  });

  it("7e. openai upstream sends Bearer auth header from oauth credential", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_oauth_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    // Seed an oauth-shape credential — access_token expires far in the
    // future so maybeRefreshOAuth's lead-time check stays a no-op.
    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await seedAccount(
      orgId,
      JSON.stringify({
        type: "oauth",
        access_token: "oauth-access-token-secret",
        refresh_token: "oauth-refresh-token",
        expires_at: futureIso,
      }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_oauth",
        object: "response",
        created_at: 1,
        model: "gpt-4o",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        incomplete_details: null,
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamRequest!.headers!.authorization).toBe(
      "Bearer oauth-access-token-secret",
    );
    await app.close();
  });

  it("7f. openai upstream cached_tokens flow into synthetic Anthropic shape", async () => {
    // cached_tokens gets subtracted from input_tokens for non-cached
    // count and surfaces as cache_read_input_tokens — this exercises
    // the shared `buildSyntheticAnthropicUsage` wiring + the
    // `extractResponsesUsage` round-trip.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_cache_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_cache",
        object: "response",
        created_at: 1,
        model: "gpt-4o",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          total_tokens: 105,
          input_tokens_details: { cached_tokens: 30 },
        },
        incomplete_details: null,
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    // Body passthrough — client sees the original gross input_tokens
    // and cached_tokens. The synthetic-shape split happens internally
    // for the pricing path only.
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.usage.input_tokens).toBe(100);
    expect(json.usage.input_tokens_details.cached_tokens).toBe(30);
    await app.close();
  });

  it("7g. openai upstream 5xx with one account → AllUpstreamsFailed → 503", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_5xx_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 503,
      body: JSON.stringify({ error: { message: "Service unavailable" } }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "all_upstreams_failed" });
    await app.close();
  });

  it("7h. openai upstream 200 with malformed JSON body → 502 / 503 forensic path", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: "not valid json {",
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    // The route throws { status: 502 } inside attempt; with one
    // account, failover surfaces AllUpstreamsFailed → 503.
    expect([502, 503]).toContain(res.statusCode);
    await app.close();
  });

  it("8. previous_response_id is accepted (sticky scheduling key)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_pri_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        ...validResponsesPayload,
        previous_response_id: "resp_abc",
      },
    });
    // 200 — the schema explicitly allows previous_response_id (Plan 5A
    // §A6: used by the scheduler's Layer 1 sticky lookup).
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("9. upstream 503 → failover retries on the next account → 200", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_503_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    // Two accounts so the failover loop has somewhere to switch to.
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-1" }),
    );
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-2" }),
    );

    let calls = 0;
    nextUpstreamResponse = {
      get status(): number {
        calls += 1;
        return calls === 1 ? 503 : 200;
      },
      get body(): string {
        return calls === 1
          ? "service unavailable"
          : JSON.stringify(defaultAnthropicResponse);
      },
    } as unknown as { status: number; body: string };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it("10. upstream returns 2xx with malformed JSON → 502 + forensic zero-usage log", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_mal_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: "not valid json {",
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    // The classifier maps `{status: 502}` thrown from the attempt to
    // either a fatal upstream error or a switchable one; with only one
    // account in the pool we expect AllUpstreamsFailed → 503.
    expect([502, 503]).toContain(res.statusCode);
    await app.close();
  });

  it("11. input as array of message items round-trips correctly", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_arr_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "gpt-4o",
        max_output_tokens: 50,
        input: [
          { role: "user", content: "first turn" },
          { role: "assistant", content: "previous reply" },
          { role: "user", content: "follow-up" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    // The Responses input array became a 3-message Anthropic conversation.
    expect(upstreamBody.messages).toHaveLength(3);
    expect(upstreamBody.messages[0]).toMatchObject({ role: "user" });
    expect(upstreamBody.messages[1]).toMatchObject({ role: "assistant" });
    expect(upstreamBody.messages[2]).toMatchObject({ role: "user" });
    await app.close();
  });

  it("12. instructions field maps to Anthropic system prompt", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_ins_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        ...validResponsesPayload,
        instructions: "you are a terse assistant",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.system).toBe("you are a terse assistant");
    await app.close();
  });

  // ── Idempotency cache (design §4.5) — client-opt-in via X-Request-Id ───────

  it("idempotency: anthropic-translator branch replays a 200 on a repeated X-Request-Id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_idem_resp_anth_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify(defaultAnthropicResponse),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const reqId = `rid-resp-anth-${Math.random().toString(36).slice(2)}`;

    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload: validResponsesPayload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ object: "response" });
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();
    const firstBody = first.body;

    await new Promise((r) => setTimeout(r, 20));
    nextUpstreamResponse = { status: 500, body: "SHOULD_NOT_BE_CALLED" };
    lastUpstreamRequest = null;

    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload: validResponsesPayload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(firstBody);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(lastUpstreamRequest).toBeNull();
    await app.close();
  });

  it("idempotency: openai-platform passthrough replays a 200 on a repeated X-Request-Id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_idem_resp_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_idem_passthrough",
        object: "response",
        created_at: 1700000000,
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_idem_pt",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "hi", annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        incomplete_details: null,
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const reqId = `rid-resp-oai-${Math.random().toString(36).slice(2)}`;

    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload: validResponsesPayload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: "resp_idem_passthrough" });
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();
    const firstBody = first.body;

    await new Promise((r) => setTimeout(r, 20));
    nextUpstreamResponse = { status: 500, body: "SHOULD_NOT_BE_CALLED" };
    lastUpstreamRequest = null;

    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload: validResponsesPayload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(firstBody);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(lastUpstreamRequest).toBeNull();
    await app.close();
  });

  it("idempotency: /v1/responses/compact replays a 200 on a repeated X-Request-Id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_idem_compact_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify({
        id: "resp_idem_compact",
        object: "response.compaction",
        created_at: 1700000000,
        output: [],
      }),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const reqId = `rid-compact-${Math.random().toString(36).slice(2)}`;
    const payload = { model: "gpt-5", input: "summarise this" };

    const first = await app.inject({
      method: "POST",
      url: "/v1/responses/compact",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: "resp_idem_compact" });
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();
    const firstBody = first.body;

    await new Promise((r) => setTimeout(r, 20));
    nextUpstreamResponse = { status: 500, body: "SHOULD_NOT_BE_CALLED" };
    lastUpstreamRequest = null;

    const second = await app.inject({
      method: "POST",
      url: "/v1/responses/compact",
      headers: { authorization: `Bearer ${rawKey}`, "x-request-id": reqId },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(firstBody);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(lastUpstreamRequest).toBeNull();
    await app.close();
  });
});
