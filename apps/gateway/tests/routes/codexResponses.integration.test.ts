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
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
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
   * When set, the fake server writes SSE chunks
   * (`event: …\ndata: …\n\n`) instead of a JSON body, with
   * `content-type: text/event-stream`. Used by the streaming test.
   */
  sseChunks?: string[];
};
let lastUpstreamRequest: {
  url: string | undefined;
  method: string | undefined;
  body?: string;
} | null;

beforeAll(async () => {
  nextUpstreamResponse = { status: 200, body: "{}" };
  lastUpstreamRequest = null;

  fakeServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      lastUpstreamRequest = { url: req.url, method: req.method, body };
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
  nextUpstreamResponse = { status: 200, body: "{}" };
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
  platform: "anthropic" | "openai" = "openai",
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

const minimalOpenaiResponse = {
  id: "resp_codex_test",
  object: "response",
  created_at: 1700000000,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_codex_1",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "hello via codex", annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  incomplete_details: null,
};

describe("/backend-api/codex/responses (Codex CLI alias)", () => {
  it("1. openai-platform key + Codex URL → 200 passthrough to OpenAI upstream", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_codex_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify(minimalOpenaiResponse),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "resp_codex_test",
      object: "response",
    });
    // Upstream got the same body — no Anthropic translation.
    expect(lastUpstreamRequest).not.toBeNull();
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.model).toBe(validResponsesPayload.model);
    expect(upstreamBody.input).toBe(validResponsesPayload.input);
    expect(upstreamBody.messages).toBeUndefined();
    await app.close();
  });

  it("2. anthropic-platform key + Codex URL → 403 route_platform_mismatch", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "anthropic");
    const rawKey = `ak_codex_anth_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-ant-test" }),
      "anthropic",
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    // forcePlatform("openai") rejects an anthropic-group request with
    // a clear "wrong route for this group" error.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "route_platform_mismatch",
      expected: "openai",
      actual: "anthropic",
    });
    // Upstream was NOT called — short-circuit happened before the
    // failover loop entered.
    expect(lastUpstreamRequest).toBeNull();
    await app.close();
  });

  it("3. legacy api key (groupId null) + Codex URL → 403 mismatch (legacy synthesises anthropic group)", async () => {
    // Legacy keys without a group_id get a synthetic anthropic-platform
    // context from groupContextPlugin. Codex CLI URL requires openai,
    // so the mismatch surfaces — protects legacy users from accidentally
    // hitting the OpenAI Responses URL with their Anthropic-binding key.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_codex_legacy_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, null);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-ant-test" }),
      "anthropic",
    );

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: "route_platform_mismatch",
      expected: "openai",
    });
    await app.close();
  });

  it("4. subpath variant: /backend-api/codex/responses/v1 also routes to the handler", async () => {
    // sub2api recorded several Codex CLI versions appending arbitrary
    // subpaths.  The wildcard `*subpath` route catches them all.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_codex_sub_${Math.random().toString(36).slice(2)}`;
    await seedApiKey(orgId, userId, rawKey, groupId);
    await seedAccount(
      orgId,
      JSON.stringify({ type: "api_key", api_key: "sk-openai-test" }),
      "openai",
      groupId,
    );

    nextUpstreamResponse = {
      status: 200,
      body: JSON.stringify(minimalOpenaiResponse),
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses/v1",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: validResponsesPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("resp_codex_test");
    await app.close();
  });

  it("5. unauthenticated request → 401 (apiKeyAuth runs before forcePlatform)", async () => {
    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses",
      payload: validResponsesPayload,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("6. stream=true through Codex URL → SSE bytes parsed and re-emitted", async () => {
    // Smoke test: streaming flows through the same handler path as
    // /v1/responses. If a future refactor accidentally short-circuits
    // the alias (e.g. swap forcePlatform for a misimplemented wrapper),
    // this catches it.
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId, "openai");
    const rawKey = `ak_codex_strm_${Math.random().toString(36).slice(2)}`;
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
          response: { id: "resp_codex_stream", model: "gpt-4o", created_at: 1 },
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "via codex",
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_codex_stream",
            status: "completed",
            incomplete_details: null,
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        })}\n\n`,
      ],
    };

    const redis = makeRedisMock();
    const app = await makeApp(redis, container.getConnectionUri());
    const res = await app.inject({
      method: "POST",
      url: "/backend-api/codex/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { ...validResponsesPayload, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body).toContain("event: response.created");
    expect(res.body).toContain("event: response.output_text.delta");
    expect(res.body).toContain('"delta":"via codex"');
    expect(res.body).toContain("event: response.completed");
    // Upstream POST was sent with stream=true on the Responses-shaped body.
    const upstreamBody = JSON.parse(lastUpstreamRequest!.body!);
    expect(upstreamBody.stream).toBe(true);
    expect(lastUpstreamRequest!.url).toBe("/v1/responses");
    await app.close();
  });
});
