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
/** Every `model` field seen this request cycle, in attempt order (failover). */
let receivedModels: string[];
/**
 * Per-bearer-token override: if the request's `Authorization: Bearer <token>`
 * is in this set, the fake upstream answers 503 (→ failover switch_account)
 * instead of a happy 200. Lets the mixed-bucket test force attempt-1 (the
 * higher-priority alias bucket) to fail over to attempt-2 (the non-alias one).
 */
let failTokens: Set<string>;

/** Build the JSON body the fake non-stream upstream echoes for `model`. */
function jsonResponse(model: string | null): string {
  return JSON.stringify({
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
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    incomplete_details: null,
  });
}

/** OpenAI Responses SSE chunks echoing `model`, ending with usage. */
function sseChunks(model: string | null): string[] {
  const id = "resp_alias_stream";
  return [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id, model: model ?? "unknown", created_at: 1 },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "ok",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        model: model ?? "unknown",
        status: "completed",
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    })}\n\n`,
  ];
}

beforeAll(async () => {
  receivedModel = null;
  receivedModels = [];
  failTokens = new Set<string>();
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
      receivedModels.push(model ?? "unknown");

      // Bucket-specific failure: extract the bearer token so the mixed-bucket
      // test can fail the alias bucket and succeed the non-alias one.
      const auth = req.headers["authorization"];
      const token =
        typeof auth === "string" && auth.startsWith("Bearer ")
          ? auth.slice("Bearer ".length)
          : "";
      if (failTokens.has(token)) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "forced failover" } }));
        return;
      }

      if (isStream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        for (const c of sseChunks(model)) res.write(c);
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(jsonResponse(model));
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
  receivedModels = [];
  failTokens = new Set<string>();
  // Each test uses a fresh app whose Fastify req-id counter restarts at
  // `req-1` (this server pins `requestIdHeader: false`), and the inline usage
  // writer dedups on ON CONFLICT(request_id). Truncate so a prior test's
  // `req-1` row can't shadow this test's `req-1` insert.
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
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

/**
 * Seed an OpenAI api_key upstream whose api_key is `token` (so the fake
 * upstream can target it for a forced 503), bound to the group at `priority`.
 */
async function seedApiKeyBucket(
  orgId: string,
  groupId: string,
  token: string,
  priority: number,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `openai-apikey-${priority}`,
      platform: "openai",
      type: "api_key",
      schedulable: true,
      status: "active",
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: token }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });

  await db
    .insert(accountGroupMembers)
    .values({ accountId: acct!.id, groupId, priority });

  return acct!.id;
}

/**
 * Seed an OpenAI oauth upstream whose access_token is `token`, bound to the
 * group at `priority`. A SECOND credential type in the group flips resolution
 * to the mixed-bucket (`upfront === null`) per-attempt path.
 */
async function seedOauthBucket(
  orgId: string,
  groupId: string,
  token: string,
  priority: number,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `openai-oauth-${priority}`,
      platform: "openai",
      type: "oauth",
      schedulable: true,
      status: "active",
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({
      type: "oauth",
      access_token: token,
      refresh_token: "rt-not-used",
      // Far-future expiry so the refresh path never runs in this test.
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  });

  await db
    .insert(accountGroupMembers)
    .values({ accountId: acct!.id, groupId, priority });

  return acct!.id;
}

/**
 * Swap the app's scheduler for a deterministic one (`topK: 1`, `random: 0`)
 * so failover order is fixed: the lowest-priority-number member is attempt-1,
 * the next is attempt-2. Lets the mixed-bucket test force a specific bucket to
 * be tried (and fail) first.
 */
async function makeDeterministic(app: FastifyInstance): Promise<void> {
  const { createScheduler } = await import("../../src/runtime/scheduler.js");
  const scheduler = createScheduler({
    db,
    redis: app.redis,
    topK: 1,
    random: () => 0,
  });
  (app as unknown as { gwScheduler: unknown }).gwScheduler = scheduler;
}

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp(
  redisMock: Redis,
  connectionString: string,
  setupRegistry: (app: FastifyInstance, baseUrl: string) => void = (
    app,
    baseUrl,
  ) => {
    // Default: seed the OpenAI api_key bucket so `gpt-5` resolves
    // deterministically (the static fallback ships gpt-5.4 / gpt-5.4-mini,
    // which do NOT contain a `gpt-5-` prefixed member). The newest member
    // `gpt-5-2025-10-01` wins; `gpt-5-mini` is excluded by the conservative
    // OpenAI family matcher.
    app.modelRegistry.set(
      { platform: "openai", baseUrl, credentialType: "api_key" },
      [
        { id: "gpt-5-2025-10-01", created: 1_700_000_000 },
        { id: "gpt-5-mini", created: 1_700_000_001 },
      ],
    );
  },
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  openaiBaseUrl = env.UPSTREAM_OPENAI_BASE_URL;
  const app = await buildServer({ env, db, redis: redisMock });
  setupRegistry(app, openaiBaseUrl);
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

/**
 * Poll usage_logs for the org/user until at least one row lands (the streaming
 * path emits the usage log fire-and-forget AFTER the SSE stream closes, so a
 * fixed sleep races the emit). Returns the rows once present.
 */
async function pollUsageRows(
  orgId: string,
  userId: string,
  timeoutMs = 5000,
): Promise<Array<{ requestedModel: string | null; upstreamModel: string | null }>> {
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

  // /v1/chat/completions openai-platform branch (Chat → Responses pivot).
  // Same single-bucket up-front resolution + per-attempt synthetic-usage
  // `attemptUpstreamModel` wiring as /v1/responses, but exercised through the
  // chat-completions route so the `makeChatCompletionsOpenaiHandler` non-stream
  // alias path has wire coverage (was responses-only before).
  it("/v1/chat/completions: resolves `gpt-5` upstream, sets the header, and logs alias→resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_oai_chat_${Math.random().toString(36).slice(2)}`;
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
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      },
    });

    expect(res.statusCode).toBe(200);
    // (a) The fake OpenAI Responses upstream received the RESOLVED id, not alias.
    expect(receivedModel).toBe(RESOLVED);
    // (b) The resolved-model header is echoed to the caller.
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);

    // (c) usage_logs: requested_model is the alias, upstream_model the resolved id.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe("gpt-5");
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });

  // Streaming single-bucket: guards the resolved-model header box wired through
  // `runOpenaiResponsesStreamingPassthrough` (writeHead-via-streamHeaders()).
  it("stream=true: resolves the alias, carries the header on the SSE response, and logs alias→resolved", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_oai_stream_${Math.random().toString(36).slice(2)}`;
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
      payload: { model: "gpt-5", input: "hi", max_output_tokens: 8, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // The fake upstream received the RESOLVED id, not the alias.
    expect(receivedModel).toBe(RESOLVED);
    // The SSE response header carries the resolved id (threaded through the box).
    expect(res.headers["x-caliber-resolved-model"]).toBe(RESOLVED);
    // The streamed events echo the resolved id back.
    expect(res.body).toContain("event: response.completed");
    expect(res.body).toContain(RESOLVED);

    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe("gpt-5");
    expect(rows[0]!.upstreamModel).toBe(RESOLVED);

    await app.close();
  });

  // Mixed-bucket failover regression for FIX 1 (per-attempt header-box reset).
  //
  // Two buckets in the group → `listCandidateTypes` returns 2 → resolution is
  // mixed-bucket (`upfront === null`), so the resolved-model header is decided
  // per attempt. With a deterministic scheduler (topK:1, random:0), the
  // lowest-priority-number member is attempt-1:
  //   • oauth bucket (priority 10): catalog HAS `gpt-5-2025-10-01` → `gpt-5`
  //     IS an alias (sets the header box to the resolved id) — but the fake
  //     upstream 503s its access_token → failover switch_account.
  //   • api_key bucket (priority 50): catalog has NO `gpt-5-` member → `gpt-5`
  //     is NOT an alias (passes through) and the upstream 200s.
  // The winning (api_key) attempt must RESET the box so the response header is
  // ABSENT. Without FIX 1 the box would retain the attempt-1 alias id and the
  // stale `x-caliber-resolved-model` header would leak.
  it("mixed-bucket failover: winning non-alias attempt resets the header (no stale value)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_oai_mixed_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);

    const oauthToken = `oauth-fail-${Math.random().toString(36).slice(2)}`;
    const apiToken = `sk-win-${Math.random().toString(36).slice(2)}`;
    // oauth = attempt-1 (lower priority number), forced to 503.
    await seedOauthBucket(orgId, groupId, oauthToken, 10);
    // api_key = attempt-2, succeeds.
    await seedApiKeyBucket(orgId, groupId, apiToken, 50);

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri(), (a, baseUrl) => {
      // oauth bucket: `gpt-5` resolves (alias).
      a.modelRegistry.set(
        { platform: "openai", baseUrl, credentialType: "oauth" },
        [{ id: "gpt-5-2025-10-01", created: 1_700_000_000 }],
      );
      // api_key bucket: NO gpt-5 family → `gpt-5` passes through unchanged.
      a.modelRegistry.set(
        { platform: "openai", baseUrl, credentialType: "api_key" },
        [{ id: "gpt-4o-mini", created: 1_700_000_000 }],
      );
    });
    await makeDeterministic(app);
    failTokens.add(oauthToken);

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: "gpt-5", input: "hi", max_output_tokens: 8, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // Both buckets were tried, in order: oauth (alias→503), then api_key (win).
    expect(receivedModels[0]).toBe(RESOLVED); // attempt-1 sent the resolved id
    expect(receivedModels[receivedModels.length - 1]).toBe("gpt-5"); // winner sent the passthrough
    // FIX 1: the winning non-alias attempt reset the box → NO stale header.
    expect(res.headers["x-caliber-resolved-model"]).toBeUndefined();

    // usage_log: requested stays the alias; upstream_model is the WINNING
    // bucket's passthrough id (gpt-5), not the failed attempt's resolved id.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe("gpt-5");
    expect(rows[0]!.upstreamModel).toBe("gpt-5");

    await app.close();
  });
});
