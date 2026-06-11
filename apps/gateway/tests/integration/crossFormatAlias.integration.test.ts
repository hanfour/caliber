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
/** Every `model` field seen this request cycle, in attempt order (failover). */
let receivedModels: string[];
/**
 * Per-credential forced 503: a request whose `x-api-key` (api_key bucket) or
 * `Authorization: Bearer <token>` (oauth bucket) is in this set answers 503 →
 * failover switch_account. Lets a two-attempt mixed-bucket test fail attempt-1
 * and win attempt-2 deterministically. Reset in `beforeEach`.
 */
let failCredentials: Set<string>;

/** The credential token a request carried, for per-credential 503 targeting. */
function credentialTokenOf(req: { headers: Record<string, unknown> }): string {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  const auth = req.headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
}

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
  receivedModels = [];
  failCredentials = new Set<string>();
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

      // Per-credential failover: fail this attempt so the next account is tried.
      if (failCredentials.has(credentialTokenOf(req))) {
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
  receivedModels = [];
  failCredentials = new Set<string>();
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

/**
 * Seed an Anthropic api_key upstream whose api_key is `token` (so the fake
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
      name: `anthropic-apikey-${priority}`,
      platform: "anthropic",
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
 * Seed an Anthropic oauth upstream whose access_token is `token`, bound to the
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
      name: `anthropic-oauth-${priority}`,
      platform: "anthropic",
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
 * Seed an Anthropic account whose ROW type is `oauth` but whose DECRYPTED
 * credential is actually an `api_key` (a stale `upstream_accounts.type`). Used
 * by the single-bucket DRIFT test: `listCandidateTypes` reports `oauth` (single
 * bucket → up-front resolution against the oauth catalog), but the live
 * credential decrypts as `api_key` → the attempt must re-resolve against the
 * api_key catalog (design invariant 5). The api_key `api_key` value is `token`
 * so the fake upstream can echo / target it.
 */
async function seedRowOauthCredApiKeyAccount(
  orgId: string,
  groupId: string,
  token: string,
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "anthropic-drift-acct",
      platform: "anthropic",
      // ROW says oauth — this is the stale hint listCandidateTypes reads.
      type: "oauth",
      schedulable: true,
      status: "active",
    })
    .returning();

  // But the vault holds an api_key credential — the live decrypted class.
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
    .values({ accountId: acct!.id, groupId, priority: 50 });

  return acct!.id;
}

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp(
  redisMock: Redis,
  connectionString: string,
  setupRegistry: (app: FastifyInstance, baseUrl: string) => void = (
    app,
    baseUrl,
  ) => {
    // Default: seed the anthropic api_key bucket deterministically so
    // `claude-haiku` resolves to a known concrete id regardless of the static
    // fallback.
    app.modelRegistry.set(
      { platform: "anthropic", baseUrl, credentialType: "api_key" },
      [{ id: RESOLVED, created: 1_700_000_000 }],
    );
  },
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  anthropicBaseUrl =
    env.UPSTREAM_ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  const app = await buildServer({ env, db, redis: redisMock });
  setupRegistry(app, anthropicBaseUrl);
  // The injected-redis (test) path skips BullMQ, so `app.usageLogQueue` is
  // undefined and emitUsageLog no-ops. Decorate a stub queue whose `add`
  // rejects → `enqueueUsageLog` writes the row inline to the DB via its
  // fallback, letting us assert the persisted requested/upstream model.
  (app as unknown as { usageLogQueue: unknown }).usageLogQueue = {
    add: () => Promise.reject(new Error("stub: force inline DB fallback")),
  };
  return app;
}

/**
 * Swap the app's scheduler for a deterministic one (`topK: 1`, `random: () => 0`)
 * so the lowest-priority-number candidate is always attempt-1 and the failover
 * order is reproducible.
 */
async function makeDeterministic(app: FastifyInstance): Promise<void> {
  const { createScheduler } = await import("../../src/runtime/scheduler.js");
  const scheduler = createScheduler({
    db,
    redis: (app as unknown as { redis: Redis }).redis,
    topK: 1,
    random: () => 0,
  });
  (app as unknown as { gwScheduler: unknown }).gwScheduler = scheduler;
}

/** Read a prom-client counter's value for a specific label set (0 if absent). */
async function counterValue(
  counter: {
    get: () => Promise<{
      values: Array<{ value: number; labels: Record<string, string | number> }>;
    }>;
  },
  match: Record<string, string>,
): Promise<number> {
  const snapshot = await counter.get();
  let total = 0;
  for (const v of snapshot.values) {
    const ok = Object.entries(match).every(
      ([k, val]) => String(v.labels[k]) === val,
    );
    if (ok) total += v.value;
  }
  return total;
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

  // ── Fast-follow B.1: single-bucket DRIFT on the cross-format Anthropic
  // branches ────────────────────────────────────────────────────────────────
  //
  // ONE account → `listCandidateTypes` returns a single type → single-bucket
  // up-front resolution. But the row type (`oauth`) ≠ the decrypted credential
  // type (`api_key`): a stale `upstream_accounts.type`. The up-front resolution
  // runs against the OAUTH catalog; the live attempt must re-resolve against the
  // API_KEY catalog (design invariant 5) and rewrite the body to the
  // credential-derived id, emit the drift warn + `gw_model_alias_bucket_drift_total`,
  // log usage_logs.upstream_model = credential-derived id (requested = alias),
  // and keep the response header consistent with what was actually sent upstream.
  // The fake upstream here is ANTHROPIC, so this proves the cross-format branch
  // faithfully replicates the `messages.ts` drift handling.

  // /v1/responses anthropic branch drift.
  it("/v1/responses drift: row type ≠ credential type → live call re-resolves against the Anthropic credential bucket, drift metric + header + usage consistent", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_resp_drift_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);
    const apiToken = `sk-ant-drift-${Math.random().toString(36).slice(2)}`;
    await seedRowOauthCredApiKeyAccount(orgId, groupId, apiToken);

    // oauth (row-type) catalog resolves the alias to one id; api_key
    // (credential-derived) catalog resolves it to a DIFFERENT id → observable
    // drift on the Anthropic wire.
    const OAUTH_RESOLVED = "claude-haiku-4-5-20251001";
    const APIKEY_RESOLVED = "claude-haiku-9-9-29990101";
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri(), (a, baseUrl) => {
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "oauth" },
        [{ id: OAUTH_RESOLVED, created: 1_700_000_000 }],
      );
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "api_key" },
        [{ id: APIKEY_RESOLVED, created: 1_900_000_000 }],
      );
    });

    const before = await counterValue(app.gwMetrics.modelAliasBucketDriftTotal, {
      platform: "anthropic",
    });
    const warnings: unknown[] = [];
    const origWarn = app.log.warn.bind(app.log);
    (app.log as unknown as { warn: (...a: unknown[]) => void }).warn = (
      ...args: unknown[]
    ) => {
      warnings.push(args[0]);
      return origWarn(...(args as Parameters<typeof origWarn>));
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: ALIAS, input: "hi", max_output_tokens: 8 },
    });

    expect(res.statusCode).toBe(200);
    // The LIVE attempt re-resolved against the credential (api_key) bucket: the
    // Anthropic upstream received the credential-derived id, NOT the oauth id.
    expect(receivedModel).toBe(APIKEY_RESOLVED);
    // The response header advertises the SAME id the upstream actually got.
    expect(res.headers["x-caliber-resolved-model"]).toBe(APIKEY_RESOLVED);

    // Drift metric incremented + warn emitted.
    const after = await counterValue(app.gwMetrics.modelAliasBucketDriftTotal, {
      platform: "anthropic",
    });
    expect(after).toBe(before + 1);
    const droveDrift = warnings.some(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        "rowResolvedModel" in (w as Record<string, unknown>),
    );
    expect(droveDrift).toBe(true);

    // usage_log: requested stays the alias; upstream_model is the
    // credential-derived (drift) id, NOT the row-type up-front id.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(APIKEY_RESOLVED);

    await app.close();
  });

  // /v1/chat/completions anthropic branch drift (the second cross-format branch).
  it("/v1/chat/completions drift: row type ≠ credential type → live call re-resolves against the Anthropic credential bucket, drift metric + header + usage consistent", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_chat_drift_${Math.random().toString(36).slice(2)}`;
    await seedKey(orgId, userId, rawKey, groupId);
    const apiToken = `sk-ant-drift-${Math.random().toString(36).slice(2)}`;
    await seedRowOauthCredApiKeyAccount(orgId, groupId, apiToken);

    const OAUTH_RESOLVED = "claude-haiku-4-5-20251001";
    const APIKEY_RESOLVED = "claude-haiku-9-9-29990101";
    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri(), (a, baseUrl) => {
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "oauth" },
        [{ id: OAUTH_RESOLVED, created: 1_700_000_000 }],
      );
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "api_key" },
        [{ id: APIKEY_RESOLVED, created: 1_900_000_000 }],
      );
    });

    const before = await counterValue(app.gwMetrics.modelAliasBucketDriftTotal, {
      platform: "anthropic",
    });
    const warnings: unknown[] = [];
    const origWarn = app.log.warn.bind(app.log);
    (app.log as unknown as { warn: (...a: unknown[]) => void }).warn = (
      ...args: unknown[]
    ) => {
      warnings.push(args[0]);
      return origWarn(...(args as Parameters<typeof origWarn>));
    };

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
    expect(receivedModel).toBe(APIKEY_RESOLVED);
    expect(res.headers["x-caliber-resolved-model"]).toBe(APIKEY_RESOLVED);

    const after = await counterValue(app.gwMetrics.modelAliasBucketDriftTotal, {
      platform: "anthropic",
    });
    expect(after).toBe(before + 1);
    const droveDrift = warnings.some(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        "rowResolvedModel" in (w as Record<string, unknown>),
    );
    expect(droveDrift).toBe(true);

    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(APIKEY_RESOLVED);

    await app.close();
  });

  // ── Fast-follow B.2: mixed-bucket failover header-leak guard on a cross-format
  // Anthropic branch (non-stream) ─────────────────────────────────────────────
  //
  // Two candidate accounts of DIFFERENT credential types (oauth + api_key) →
  // `listCandidateTypes` returns 2 → resolution is mixed-bucket
  // (`resolution.cacheable === false`, `upfront === null`), so the resolved-model
  // header is decided PER ATTEMPT. With a deterministic scheduler (topK:1,
  // random:0) the lowest-priority-number member is attempt-1:
  //   • oauth bucket (priority 10): catalog HAS the alias family → the alias
  //     resolves (sets the reply header to the resolved id) — but the fake
  //     Anthropic upstream 503s its access_token → failover switch_account.
  //   • api_key bucket (priority 50): catalog has NO matching family → the alias
  //     is NOT an alias there (passes through) and the upstream 200s.
  // The winning (api_key) non-alias attempt must CLEAR the header so the response
  // does NOT advertise attempt-1's stale resolved id. Guards the cross-format
  // header-box reset on the winning attempt.
  it("/v1/responses mixed-bucket non-stream failover: winning non-alias Anthropic attempt clears the stale header (no leak)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const groupId = await seedGroup(orgId);
    const rawKey = `ak_cf_resp_leak_${Math.random().toString(36).slice(2)}`;
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
      // oauth bucket: the alias resolves → sets the reply header.
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "oauth" },
        [{ id: RESOLVED, created: 1_700_000_000 }],
      );
      // api_key bucket: NO claude-haiku family → the alias passes through.
      a.modelRegistry.set(
        { platform: "anthropic", baseUrl, credentialType: "api_key" },
        [{ id: "claude-sonnet-4-5-20250101", created: 1_700_000_000 }],
      );
    });
    await makeDeterministic(app);
    failCredentials.add(oauthToken);

    // NON-stream (no stream:true) so the reply-header mutate path is exercised.
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { model: ALIAS, input: "hi", max_output_tokens: 8 },
    });

    expect(res.statusCode).toBe(200);
    // Both buckets tried in order: oauth (alias→503) then api_key (win).
    expect(receivedModels[0]).toBe(RESOLVED); // attempt-1 sent the resolved id
    expect(receivedModels[receivedModels.length - 1]).toBe(ALIAS); // winner passthrough
    // The winning non-alias attempt CLEARED the header → NOT the stale attempt-1
    // resolved id, and ABSENT entirely (reflects the WINNING attempt's bucket,
    // which treats the model as non-alias).
    expect(res.headers["x-caliber-resolved-model"]).toBeUndefined();

    // usage_log: requested stays the alias; upstream_model is the WINNING
    // bucket's passthrough id (the bare alias), not the failed attempt's
    // resolved id.
    const rows = await pollUsageRows(orgId, userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe(ALIAS);
    expect(rows[0]!.upstreamModel).toBe(ALIAS);

    await app.close();
  });
});
