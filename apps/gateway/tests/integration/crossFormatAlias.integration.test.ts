import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
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

// ---------------------------------------------------------------------------
// Finding 1 (cross-format parity): the Anthropic-upstream branches of the two
// OpenAI-compatible surfaces — `/v1/chat/completions` (Chat → Anthropic) and
// `/v1/responses` (Responses → Anthropic) — must resolve model aliases against
// the ANTHROPIC catalog and forward the RESOLVED id to the Anthropic upstream
// (previously they bypassed alias resolution entirely).
//
// The fake upstream is an ANTHROPIC Messages server echoing the `model` it
// received, so each test asserts: (a) the upstream saw the resolved id, (b)
// `x-caliber-resolved-model` is set, (c) usage_logs requested=alias /
// upstream=resolved.
// ---------------------------------------------------------------------------

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
/** The `model` field the fake upstream saw on the last request body. */
let receivedModel: string | null;

/** Anthropic Messages SSE chunks echoing `model`, ending with usage. */
function sseChunks(model: string | null): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_alias_stream",
        type: "message",
        role: "assistant",
        model: model ?? "unknown",
        content: [],
        stop_reason: null,
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
      delta: { type: "text_delta", text: "ok" },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
    })}\n\n`,
  ];
}

beforeAll(async () => {
  receivedModel = null;
  fakeServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      let model: string | null = null;
      let isStream = false;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        model = typeof parsed.model === "string" ? parsed.model : null;
        isStream = parsed.stream === true;
      } catch {
        model = null;
      }
      receivedModel = model;

      if (isStream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        for (const c of sseChunks(model)) res.write(c);
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_alias_echo",
          type: "message",
          role: "assistant",
          model: model ?? "unknown",
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

beforeEach(async () => {
  receivedModel = null;
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// The alias the client sends + the concrete id the anthropic catalog resolves
// it to (seeded deterministically via app.modelRegistry.set below).
const ALIAS = "claude-haiku";
const RESOLVED = "claude-haiku-4-5-20251001";

// The anthropic bucket baseUrl resolution + registry lookup key on — must equal
// the `UPSTREAM_ANTHROPIC_BASE_URL` the routes pass to applyModelResolution.
let anthropicBaseUrl: string;

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

/** Anthropic-platform group → routes dispatch to the Anthropic branch. */
async function seedGroup(orgId: string): Promise<string> {
  const [group] = await db
    .insert(accountGroups)
    .values({
      orgId,
      name: `grp-${Math.random().toString(36).slice(2, 8)}`,
      platform: "anthropic",
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
    name: "test-key-anthropic",
    groupId,
  });
}

/**
 * Seed a single pool api_key Anthropic upstream + its credential, bound to the
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
      name: "anthropic-apikey-acct",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: "sk-anthropic-test" }),
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
  anthropicBaseUrl =
    env.UPSTREAM_ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const app = await buildServer({ env, db, redis: redisMock });
  // Seed the anthropic api_key bucket deterministically so `claude-haiku`
  // resolves to a known concrete id regardless of the static fallback.
  app.modelRegistry.set(
    { platform: "anthropic", baseUrl: anthropicBaseUrl, credentialType: "api_key" },
    [{ id: RESOLVED, created: 1_700_000_000 }],
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

/** Poll usage_logs for the org/user until at least one row lands. */
async function pollUsageRows(
  orgId: string,
  userId: string,
  timeoutMs = 5000,
): Promise<
  Array<{ requestedModel: string | null; upstreamModel: string | null }>
> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select({
        requestedModel: usageLogs.requestedModel,
        upstreamModel: usageLogs.upstreamModel,
      })
      .from(usageLogs)
      .where(and(eq(usageLogs.orgId, orgId), eq(usageLogs.userId, userId)));
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Anthropic-upstream cross-format surfaces — model alias resolution", () => {
  it("/v1/chat/completions: resolves the alias against the Anthropic catalog, sets the header, logs alias→resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_chat_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);
    await seedGroupApiKeyAccount(orgId, groupId);

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: ALIAS,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      },
    });

    expect(res.statusCode).toBe(200);
    // (a) The fake Anthropic upstream received the RESOLVED id, not the alias.
    expect(receivedModel).toBe(RESOLVED);
    // (b) The resolved-model header is echoed to the caller.
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    // (c) usage_logs: requested_model is the alias, upstream_model the resolved id.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });

  it("/v1/responses: resolves the alias against the Anthropic catalog, sets the header, logs alias→resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_resp_${Math.random().toString(36).slice(2)}`;
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
        model: ALIAS,
        input: "hi",
        max_output_tokens: 8,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(receivedModel).toBe(RESOLVED);
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });

  // Streaming /v1/responses — guards the resolved-model header box (written via
  // streamHeaders()) AND the synthetic usage-threading fix: the streaming usage
  // block has no model field, so `upstream_model` must be threaded from the
  // resolved id, not the alias (Anthropic-streaming analog of Finding #4).
  it("/v1/responses stream=true: carries the header on the SSE response and logs upstream_model=resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_stream_${Math.random().toString(36).slice(2)}`;
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
        model: ALIAS,
        input: "hi",
        max_output_tokens: 8,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // The fake upstream received the RESOLVED id, not the alias.
    expect(receivedModel).toBe(RESOLVED);
    // The SSE response header carries the resolved id (threaded through the box).
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    // usage_log: requested stays the alias; upstream_model is the RESOLVED id
    // (threaded into syntheticAnthropicFromResponsesUsage — the captured usage
    // block carries no model field, so this guards the streaming-usage fix).
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });

  // Streaming /v1/chat/completions — the Chat→Anthropic streaming path
  // (`runChatCompletionsStreamingFailover`) consumes the SAME Anthropic upstream
  // SSE via `parseAnthropicSse`, then translates to OpenAI Chat chunks. Guards
  // the resolved-model header box (written via streamHeaders()) AND the synthetic
  // usage-threading: `lastUsageChunk` carries the upstream-echoed model, so
  // `upstream_model` must be the resolved id, not the alias.
  it("/v1/chat/completions stream=true: carries the header on the SSE response and logs upstream_model=resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_chat_stream_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);
    await seedGroupApiKeyAccount(orgId, groupId);

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: ALIAS,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // The fake Anthropic upstream received the RESOLVED id, not the alias.
    expect(receivedModel).toBe(RESOLVED);
    // The SSE response header carries the resolved id (threaded through the box).
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    // usage_log: requested stays the alias; upstream_model is the RESOLVED id.
    // The translated Chat usage chunk carries `model` from the upstream-echoed
    // message_start, which `syntheticAnthropicResponse` threads into the row.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });
});
