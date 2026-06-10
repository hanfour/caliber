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

// ── Fake upstream (Anthropic) HTTP server ────────────────────────────────────
//
// Records EVERY `model` field it saw (one entry per request) so the test can
// assert (a) the cache HIT never reached upstream a second time and (b) the
// drift attempt forwarded the credential-derived id, not the row-type id.

let fakeServer: Server;
let fakeBaseUrl: string;
let receivedModels: string[];
// Per-credential forced 503: a request whose `x-api-key` (api_key bucket) or
// `Authorization: Bearer <token>` (oauth bucket) is in this set answers 503 →
// failover switch_account. Lets a two-attempt drift test fail attempt-1 and
// win attempt-2 deterministically. Reset in `beforeEach`.
let failCredentials: Set<string>;

/** Anthropic SSE chunks echoing `model` back (message_start → delta → stop). */
function anthropicSseChunks(model: string | null): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_alias_stream",
        type: "message",
        role: "assistant",
        model: model ?? "unknown",
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
}

/** The credential token a request carried, for per-credential 503 targeting. */
function credentialTokenOf(req: { headers: Record<string, unknown> }): string {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  const auth = req.headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
}

beforeAll(async () => {
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
      if (model) receivedModels.push(model);

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
        for (const c of anthropicSseChunks(model)) res.write(c);
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
  receivedModels = [];
  failCredentials = new Set<string>();
  // Each freshly-built app restarts Fastify's request-id counter at `req-1`,
  // and `writeUsageLogBatch` upserts ON CONFLICT(request_id) DO NOTHING with a
  // GLOBALLY-unique request_id — so a second `it`'s `req-1` usage row would
  // silently collide with the first's. Clear the table between tests to keep
  // the per-test usage-log assertions independent.
  await db.delete(usageLogs);
});

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// The newest haiku id in the SHIPPED static fallback catalog — the resolution
// any bucket on the fallback produces for the `claude-haiku` alias.
const FALLBACK_RESOLVED = "claude-haiku-4-5-20251001";

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
    GATEWAY_ENABLE_MODEL_ALIAS: "true",
    // Enable the response cache for this suite (default is 0 = disabled).
    GATEWAY_CACHE_TTL_SEC: "60",
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

async function seedOwnKey(
  orgId: string,
  userId: string,
  rawKey: string,
): Promise<void> {
  await db.insert(apiKeys).values({
    orgId,
    userId,
    keyHash: hashApiKey(pepper, rawKey),
    keyPrefix: rawKey.slice(0, 8),
    name: "test-key-own",
    groupId: null,
    routingPolicy: "own",
  });
}

/**
 * Seed a user-owned anthropic upstream whose ROW `type` is `rowType` while its
 * decrypted vault credential carries `credType`. When the two agree (the normal
 * case) this is an ordinary account; when they disagree it is the drift fixture
 * — the bucket preview (`listCandidateTypes` reads `upstream_accounts.type`)
 * sees `rowType`, but the live attempt (`resolveCredential` reads the vault JSON
 * `type`) sees `credType`.
 */
async function seedOwnAccount(
  orgId: string,
  userId: string,
  rowType: "api_key" | "oauth",
  credType: "api_key" | "oauth",
  opts: { priority?: number; credToken?: string } = {},
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      userId,
      name: `own-${rowType}-${Math.random().toString(36).slice(2, 8)}`,
      platform: "anthropic",
      type: rowType,
      schedulable: true,
      status: "active",
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    })
    .returning();

  // The credential token (api_key value or oauth access_token) — distinct per
  // account when `credToken` is supplied so the fake upstream can target one
  // attempt for a forced 503 in failover tests.
  const token =
    opts.credToken ??
    (credType === "api_key" ? "sk-ant-test-key" : "oauth-access-token-test");

  const plaintext =
    credType === "api_key"
      ? JSON.stringify({ type: "api_key", api_key: token })
      : JSON.stringify({
          type: "oauth",
          access_token: token,
          refresh_token: "oauth-refresh-token-test",
          expires_at: new Date(
            Date.now() + 365 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext,
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

async function makeApp(
  redisMock: Redis,
  connectionString: string,
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString));
  const app = await buildServer({ env, db, redis: redisMock });
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /v1/messages — model alias + response cache", () => {
  it("(a) caches under the resolved-model key and replays x-caliber-resolved-model on a HIT", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_aliascache_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    // Single-bucket (one candidate type) → resolution.cacheable + upfront set.
    await seedOwnAccount(orgId, userId, "api_key", "api_key");

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const payload = {
      model: "claude-haiku",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    };

    // First call — MISS: resolves + dispatches upstream + caches.
    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("miss");
    expect(first.headers["x-caliber-resolved-model"]).toBe(FALLBACK_RESOLVED);
    expect(receivedModels).toEqual([FALLBACK_RESOLVED]);

    // Second identical call — HIT: served from cache, upstream NOT re-hit, and
    // the resolved-model header is still present on the cached reply.
    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload,
    });

    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("hit");
    expect(second.headers["x-caliber-resolved-model"]).toBe(FALLBACK_RESOLVED);
    // Upstream was only ever hit ONCE (the miss); the hit short-circuited.
    expect(receivedModels).toEqual([FALLBACK_RESOLVED]);

    await app.close();
  });

  it("(b) row type ≠ credential type + cache enabled: cache key uses row-type resolution, live attempt re-resolves against the credential bucket + emits drift warn/metric", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_aliasdrift_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    // Row says `oauth`; the vault credential decrypts to `api_key`. The bucket
    // preview reads the row (oauth → static fallback), the live attempt reads
    // the credential (api_key → registry-overridden catalog below).
    await seedOwnAccount(orgId, userId, "oauth", "api_key");

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    // Override the api_key (credential-derived) bucket so `claude-haiku`
    // resolves to a DIFFERENT concrete id than the oauth (row-type) bucket,
    // which stays on the static fallback. This makes the drift observable on
    // the wire: the upstream must receive the credential-derived id.
    const DRIFT_RESOLVED = "claude-haiku-9-9-29990101";
    app.modelRegistry.set(
      {
        platform: "anthropic",
        baseUrl: fakeBaseUrl,
        credentialType: "api_key",
      },
      [{ id: DRIFT_RESOLVED, created: 1_900_000_000 }],
    );

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
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-haiku",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(res.statusCode).toBe(200);

    // The LIVE attempt re-resolved against the credential bucket: the upstream
    // received the credential-derived id, NOT the row-type (fallback) id.
    expect(receivedModels).toEqual([DRIFT_RESOLVED]);

    // The response header must advertise the SAME id the upstream actually got
    // (the credential-derived drift id), not the up-front row-type id. Guards
    // the non-stream drift header re-affirm.
    expect(res.headers["x-caliber-resolved-model"]).toBe(DRIFT_RESOLVED);

    // Drift metric incremented for the anthropic platform.
    const after = await counterValue(app.gwMetrics.modelAliasBucketDriftTotal, {
      platform: "anthropic",
    });
    expect(after).toBe(before + 1);

    // Drift warning emitted.
    const droveDrift = warnings.some(
      (w) =>
        typeof w === "object" &&
        w !== null &&
        "rowResolvedModel" in (w as Record<string, unknown>),
    );
    expect(droveDrift).toBe(true);

    // The usage log still records the original alias as requested_model and the
    // credential-derived id as upstream_model. Poll — the inline DB-fallback
    // write is fire-and-forget after the response flushes.
    let rows: Array<{
      requestedModel: string | null;
      upstreamModel: string | null;
    }> = [];
    const deadline = Date.now() + 5000;
    for (;;) {
      rows = await db
        .select({
          requestedModel: usageLogs.requestedModel,
          upstreamModel: usageLogs.upstreamModel,
        })
        .from(usageLogs)
        .where(and(eq(usageLogs.orgId, orgId), eq(usageLogs.userId, userId)));
      if (rows.length > 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBe(1);
    expect(rows[0]!.requestedModel).toBe("claude-haiku");
    expect(rows[0]!.upstreamModel).toBe(DRIFT_RESOLVED);

    await app.close();
  });

  it("(c) stream=true drift: SSE x-caliber-resolved-model advertises the credential-derived id, not the row-type id", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_aliasdriftstream_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    // Row says `oauth` (single-bucket on oauth → upfront seeds the SSE header
    // box to the fallback id); the vault credential decrypts to `api_key`, whose
    // registry-overridden catalog resolves `claude-haiku` to a DIFFERENT id.
    await seedOwnAccount(orgId, userId, "oauth", "api_key");

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());

    const DRIFT_RESOLVED = "claude-haiku-9-9-29990101";
    app.modelRegistry.set(
      { platform: "anthropic", baseUrl: fakeBaseUrl, credentialType: "api_key" },
      [{ id: DRIFT_RESOLVED, created: 1_900_000_000 }],
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-haiku",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // The live attempt sent the credential-derived id upstream...
    expect(receivedModels).toEqual([DRIFT_RESOLVED]);
    // ...and the SSE response header must advertise that SAME id, NOT the
    // up-front row-type (fallback) id the box was seeded with. Guards the
    // streaming drift header re-point.
    expect(res.headers["x-caliber-resolved-model"]).toBe(DRIFT_RESOLVED);
    expect(res.body).toContain("event: message_stop");

    await app.close();
  });

  it("(d) stream=true single-bucket failover: attempt-1 drifts then 503s, attempt-2 wins on the row bucket → header reflects attempt-2's id, NOT attempt-1's drifted id (FIX 1 regression guard)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_aliasdriftfail_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);

    // BOTH accounts have ROW type `oauth` → single-bucket (upfront resolves on
    // the oauth bucket = the static fallback id). The failover spans two
    // attempts inside that one bucket:
    //   • attempt-1 (priority 10): credential decrypts to `api_key` → DRIFTS to
    //     the api_key registry id (sets the SSE box to the drifted id) — then
    //     the fake 503s its x-api-key → failover switch_account.
    //   • attempt-2 (priority 50): credential decrypts to `oauth` → NO drift
    //     (matches the row bucket, stays on the fallback id) → 200 wins.
    // Without FIX 1 the box would retain attempt-1's drifted id (the no-drift
    // branch only wrote ON drift) → the SSE header would lie. With FIX 1 the
    // box is reset every attempt, so the header reflects attempt-2's id.
    const failKey = `sk-ant-drift-${Math.random().toString(36).slice(2)}`;
    await seedOwnAccount(orgId, userId, "oauth", "api_key", {
      priority: 10,
      credToken: failKey,
    });
    await seedOwnAccount(orgId, userId, "oauth", "oauth", {
      priority: 50,
      credToken: `oauth-win-${Math.random().toString(36).slice(2)}`,
    });

    const redis = new RedisMock({
      keyPrefix: "caliber:gw:",
    }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    // api_key bucket resolves `claude-haiku` to a distinct (drifted) id; the
    // oauth (row) bucket stays on the shipped static fallback.
    const DRIFT_RESOLVED = "claude-haiku-9-9-29990101";
    app.modelRegistry.set(
      { platform: "anthropic", baseUrl: fakeBaseUrl, credentialType: "api_key" },
      [{ id: DRIFT_RESOLVED, created: 1_900_000_000 }],
    );

    // Fail attempt-1 (its decrypted api_key credential) so attempt-2 is tried.
    failCredentials.add(failKey);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {
        model: "claude-haiku",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    // Both attempts were made, in order: drifted api_key (503), then oauth (win).
    expect(receivedModels[0]).toBe(DRIFT_RESOLVED);
    expect(receivedModels[receivedModels.length - 1]).toBe(FALLBACK_RESOLVED);
    // FIX 1: the winning (no-drift) attempt reset the box → the SSE header
    // carries attempt-2's fallback id, NOT attempt-1's stale drifted id.
    expect(res.headers["x-caliber-resolved-model"]).toBe(FALLBACK_RESOLVED);

    await app.close();
  });
});
