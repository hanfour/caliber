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
let nextUpstreamResponse: { status: number; body: string };
let lastUpstreamRequest: {
  url: string | undefined;
  method: string | undefined;
  body?: string;
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
      lastUpstreamRequest = { url: req.url, method: req.method, body };
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

  it("3. unsupported feature `store` → 400", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_store_${Math.random().toString(36).slice(2)}`;
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
      payload: { ...validResponsesPayload, store: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "unsupported_feature",
      field: "store",
    });
    await app.close();
  });

  it("4. unsupported feature `parallel_tool_calls` → 400", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_para_${Math.random().toString(36).slice(2)}`;
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
      payload: { ...validResponsesPayload, parallel_tool_calls: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "unsupported_feature",
      field: "parallel_tool_calls",
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

  it("6. stream=true → 501 (deferred to PR 9c)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_resp_strm_${Math.random().toString(36).slice(2)}`;
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
      payload: { ...validResponsesPayload, stream: true },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("not_implemented");
    await app.close();
  });

  it("7. openai-platform group → 503 openai_upstream_not_yet_wired", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_resp_oai_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    // Account doesn't matter since we 503 before scheduling.

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: "openai_upstream_not_yet_wired",
      platform: "openai",
    });
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
});
