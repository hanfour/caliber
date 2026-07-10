import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import { authFailKey } from "@caliber/gateway-core/redis";
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

// ─────────────────────────────────────────────────────────────────────────────
// Task 14 — END-TO-END api_key credential-health.
//
// Proves the whole feature against a REAL Postgres + a fake Anthropic upstream
// that can force a chosen HTTP status PER credential token:
//   • degrade after N=3 consecutive 401s (and the FIRST degrade actually WRITES
//     against a NULL-reason healthy row — the NULL-safe `or(...)` guard),
//     incrementing gw_upstream_credential_degraded_total exactly once;
//   • the scheduler then SKIPS the degraded account (503 no_upstream_available);
//   • a later 2xx CLEARS the temp fields (recover);
//   • a 400 is fatal — does NOT degrade, does NOT touch the authfail counter;
//   • a 403 fails over to a healthy peer and does NOT degrade account A.
//
// Harness is copied from messages.aliasCache.integration.test.ts (own-path,
// anthropic, deterministic scheduler, prom-counter scrape, usage_log poll). The
// per-credential 503 mechanism is generalised to a per-credential FORCED STATUS
// map so we can drive 401/400/403/200 at a specific account.
// ─────────────────────────────────────────────────────────────────────────────

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
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

// ── Fake upstream (Anthropic) HTTP server ────────────────────────────────────
//
// Per-credential forced status: a request whose decrypted credential token
// (x-api-key in the api_key bucket) is a key of `forceStatus` answers with that
// status + a JSON error body. Anything not in the map → 200 echo. Reset per test.

let fakeServer: Server;
let fakeBaseUrl: string;
let receivedTokens: string[];
let forceStatus: Map<string, number>;

/** The credential token a request carried (api_key bucket → x-api-key). */
function credentialTokenOf(req: { headers: Record<string, unknown> }): string {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  const auth = req.headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
}

beforeAll(async () => {
  receivedTokens = [];
  forceStatus = new Map<string, number>();
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

      const token = credentialTokenOf(req);
      receivedTokens.push(token);

      const forced = forceStatus.get(token);
      if (forced !== undefined && forced >= 300) {
        res.statusCode = forced;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "forced", message: `forced ${forced}` },
          }),
        );
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_credhealth_echo",
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
  receivedTokens = [];
  forceStatus = new Map<string, number>();
  // Usage upsert is ON CONFLICT(request_id) DO NOTHING; clear the table between
  // tests so each test's usage assertions are independent.
  await db.delete(usageLogs);
});

// ── Constants ────────────────────────────────────────────────────────────────

const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

// Alias resolution is irrelevant to credential-health; disable it so the body
// model passes straight through (keeps the fake-upstream echo deterministic).

// ── Environment helper ───────────────────────────────────────────────────────

function buildEnv(
  connectionString: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    GATEWAY_ENABLE_MODEL_ALIAS: "false",
    GATEWAY_CACHE_TTL_SEC: "0",
    // N=3 (default) consecutive 401s → degrade.
    GATEWAY_UPSTREAM_AUTH_MAX_FAIL: "3",
    ...overrides,
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
 * Seed a user-owned anthropic api_key upstream whose decrypted credential token
 * (x-api-key) is `credToken`, at the given `priority`. The fake upstream can
 * target it by token for a forced status.
 */
async function seedOwnApiKeyAccount(
  orgId: string,
  userId: string,
  credToken: string,
  opts: { priority?: number } = {},
): Promise<string> {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      userId,
      name: `own-apikey-${Math.random().toString(36).slice(2, 8)}`,
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    })
    .returning();

  const sealed = encryptCredential({
    masterKeyHex: masterKey,
    accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: credToken }),
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
  envOverrides: Record<string, unknown> = {},
): Promise<FastifyInstance> {
  const { parseServerEnv } = await import("@caliber/config");
  const env = parseServerEnv(buildEnv(connectionString, envOverrides));
  const app = await buildServer({ env, db, redis: redisMock });
  (app as unknown as { usageLogQueue: unknown }).usageLogQueue = {
    add: () => Promise.reject(new Error("stub: force inline DB fallback")),
  };
  return app;
}

/** Deterministic scheduler: lowest-priority-number candidate is always tried first. */
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

/** Read a prom-client counter's value for a label set (0 if absent). */
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

/** Fetch the current temp-health columns for an account. */
async function accountHealth(accountId: string): Promise<{
  tempUnschedulableReason: string | null;
  tempUnschedulableUntil: Date | null;
  errorMessage: string | null;
  status: string;
}> {
  const [row] = await db
    .select({
      tempUnschedulableReason: upstreamAccounts.tempUnschedulableReason,
      tempUnschedulableUntil: upstreamAccounts.tempUnschedulableUntil,
      errorMessage: upstreamAccounts.errorMessage,
      status: upstreamAccounts.status,
    })
    .from(upstreamAccounts)
    .where(eq(upstreamAccounts.id, accountId));
  return row!;
}

const messagesPayload = {
  model: "claude-3-5-haiku-20241022",
  max_tokens: 8,
  messages: [{ role: "user", content: "hi" }],
};

async function post(app: FastifyInstance, rawKey: string) {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: `Bearer ${rawKey}` },
    payload: messagesPayload,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("api_key upstream credential health (end-to-end)", () => {
  it("degrades after N=3 consecutive 401s — first degrade WRITES the NULL-reason healthy row + metric increments exactly once", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_degrade_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    const credToken = `sk-ant-dead-${Math.random().toString(36).slice(2)}`;
    const accountId = await seedOwnApiKeyAccount(orgId, userId, credToken);

    const redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    // The single seeded account's credential always 401s.
    forceStatus.set(credToken, 401);

    const before = await counterValue(
      app.gwMetrics.upstreamCredentialDegradedTotal,
      { platform: "anthropic" },
    );

    // Sanity: healthy row starts with a NULL reason (the NULL-safe guard target).
    expect((await accountHealth(accountId)).tempUnschedulableReason).toBeNull();

    // 3 requests, each routes to the SAME (only) account → 401 → switch_account
    // → recordAuthFailure. The account is the sole candidate so every request
    // exhausts to 503 all_upstreams_failed, but the per-attempt 401 still ran.
    for (let i = 0; i < 3; i++) {
      const res = await post(app, rawKey);
      expect(res.statusCode).toBe(503);
    }

    // After the 3rd 401 the account is degraded RECOVERABLY: temp fields set,
    // status untouched, errorMessage written.
    const health = await accountHealth(accountId);
    expect(health.tempUnschedulableReason).toBe("api_key_invalid_credential");
    expect(health.errorMessage).toBe("upstream rejected credential (401)");
    expect(health.tempUnschedulableUntil).not.toBeNull();
    expect(health.tempUnschedulableUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(health.status).toBe("active"); // RECOVERABLE — never flipped status.

    // The healthy→degraded transition metric incremented exactly once.
    const after = await counterValue(
      app.gwMetrics.upstreamCredentialDegradedTotal,
      { platform: "anthropic" },
    );
    expect(after).toBe(before + 1);

    // The authfail counter reached the threshold (3 consecutive 401s).
    const counter = await redis.get(authFailKey(accountId));
    expect(Number(counter)).toBe(3);

    await app.close();
  });

  it("scheduler SKIPS a degraded account — sole candidate degraded → 503 no_upstream_available", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_skip_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    const credToken = `sk-ant-skip-${Math.random().toString(36).slice(2)}`;
    const accountId = await seedOwnApiKeyAccount(orgId, userId, credToken);

    const redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    // Directly degrade the account into the future (the unit of behaviour under
    // test is the SCHEDULER filter, not the degrade write — covered above).
    await db
      .update(upstreamAccounts)
      .set({
        tempUnschedulableUntil: new Date(Date.now() + 3_600_000),
        tempUnschedulableReason: "api_key_invalid_credential",
        errorMessage: "upstream rejected credential (401)",
      })
      .where(eq(upstreamAccounts.id, accountId));

    // A 200-capable credential would serve IF it were scheduled — but the temp
    // window excludes it, so no candidate exists.
    const res = await post(app, rawKey);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("no_upstream_available");
    // The scheduler filtered it out → the upstream was never even contacted.
    expect(receivedTokens).toEqual([]);

    await app.close();
  });

  it("recovers on a later 2xx — clearAuthFailure DELs the counter + clears the temp fields", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_recover_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    const credToken = `sk-ant-recover-${Math.random().toString(36).slice(2)}`;
    const accountId = await seedOwnApiKeyAccount(orgId, userId, credToken);

    const redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    // Pre-state: the account was degraded by a prior 401 streak AND its authfail
    // counter is non-zero — but its temp window has ALREADY LAPSED (until in the
    // past), so the scheduler re-admits it for one more try. The fake upstream
    // now returns 200 → the success choke point fires clearAuthFailure.
    await redis.set(authFailKey(accountId), "3");
    await db
      .update(upstreamAccounts)
      .set({
        tempUnschedulableUntil: new Date(Date.now() - 1_000), // lapsed → schedulable
        tempUnschedulableReason: "api_key_invalid_credential",
        errorMessage: "upstream rejected credential (401)",
      })
      .where(eq(upstreamAccounts.id, accountId));

    // No forced status → the credential 200s.
    const res = await post(app, rawKey);
    expect(res.statusCode).toBe(200);
    expect(receivedTokens).toEqual([credToken]);

    // clearAuthFailure ran on the 2xx: temp fields cleared (recovered) ...
    const health = await accountHealth(accountId);
    expect(health.tempUnschedulableReason).toBeNull();
    expect(health.tempUnschedulableUntil).toBeNull();
    expect(health.errorMessage).toBeNull();

    // ... and the authfail counter was DELeted.
    const counter = await redis.get(authFailKey(accountId));
    expect(counter).toBeNull();

    await app.close();
  });

  it("400 is fatal — does NOT degrade and does NOT touch the authfail counter (client gets the {error,detail,request_id} 400 wrapper)", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_400_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);
    const credToken = `sk-ant-400-${Math.random().toString(36).slice(2)}`;
    const accountId = await seedOwnApiKeyAccount(orgId, userId, credToken);

    const redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    forceStatus.set(credToken, 400);

    const res = await post(app, rawKey);

    // 400 → classifier `fatal` → FatalUpstreamError, status preserved + wrapper.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("client_error");
    expect(typeof body.detail).toBe("string"); // the upstream body surfaced
    expect(typeof body.request_id).toBe("string");

    // NOT a degrade signal: account stays healthy.
    const health = await accountHealth(accountId);
    expect(health.tempUnschedulableReason).toBeNull();
    expect(health.tempUnschedulableUntil).toBeNull();

    // authfail counter NEVER touched (recordAuthFailure only acts on 401).
    const counter = await redis.get(authFailKey(accountId));
    expect(counter).toBeNull();

    await app.close();
  });

  it("403 fails over to a healthy peer and does NOT degrade account A", async () => {
    const orgId = await seedOrg();
    const userId = await seedUser();
    const rawKey = `ak_403_${Math.random().toString(36).slice(2)}`;
    await seedOwnKey(orgId, userId, rawKey);

    // A (priority 10) 403s; B (priority 50) 200s. Deterministic scheduler tries
    // A first → switch_account (auth_invalid, but 403 ≠ degrade) → B wins.
    const tokenA = `sk-ant-403A-${Math.random().toString(36).slice(2)}`;
    const tokenB = `sk-ant-200B-${Math.random().toString(36).slice(2)}`;
    const accountA = await seedOwnApiKeyAccount(orgId, userId, tokenA, {
      priority: 10,
    });
    const accountB = await seedOwnApiKeyAccount(orgId, userId, tokenB, {
      priority: 50,
    });

    const redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
    const app = await makeApp(redis, container.getConnectionUri());
    await makeDeterministic(app);

    forceStatus.set(tokenA, 403);
    // tokenB unset → 200.

    const res = await post(app, rawKey);

    expect(res.statusCode).toBe(200);
    // Both attempts were made, A first (403) then B (200).
    expect(receivedTokens[0]).toBe(tokenA);
    expect(receivedTokens[receivedTokens.length - 1]).toBe(tokenB);

    // A is NOT degraded (403 is failover, not a credential-degrade signal) ...
    const healthA = await accountHealth(accountA);
    expect(healthA.tempUnschedulableReason).toBeNull();
    expect(healthA.tempUnschedulableUntil).toBeNull();
    // ... and its authfail counter was never incremented (gate is 401 only).
    const counterA = await redis.get(authFailKey(accountA));
    expect(counterA).toBeNull();

    // B served the request and stays healthy.
    const healthB = await accountHealth(accountB);
    expect(healthB.tempUnschedulableReason).toBeNull();

    await app.close();
  });
});
