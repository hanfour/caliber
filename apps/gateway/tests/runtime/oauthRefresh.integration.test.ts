import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { organizations, upstreamAccounts, credentialVault } from "@aide/db";
import { encryptCredential, decryptCredential } from "@aide/gateway-core";
import {
  maybeRefreshOAuth,
  persistRefresh,
  readVaultRotatedAt,
  OAuthRefreshError,
} from "../../src/runtime/oauthRefresh.js";
import type { ResolvedCredential } from "../../src/runtime/resolveCredential.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@aide/db/package.json")),
  "drizzle",
);

// ── Postgres testcontainer ───────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "oauth-refresh-test-org", name: "OAuth Refresh Test Org" })
    .returning();
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ── Fake token HTTP server ───────────────────────────────────────────────────

let tokenServer: Server;
let tokenBaseUrl: string;
let lastTokenRequest: {
  headers: IncomingMessage["headers"];
  body: string;
} | null = null;
let nextTokenResponse: { status: number; body: string };

beforeAll(async () => {
  nextTokenResponse = { status: 200, body: "{}" };
  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastTokenRequest = { headers: req.headers, body };
      res.statusCode = nextTokenResponse.status;
      res.setHeader("content-type", "application/json");
      res.end(nextTokenResponse.body);
    });
  });
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
  const addr = tokenServer.address() as AddressInfo;
  tokenBaseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => tokenServer.close(() => r())));

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  lastTokenRequest = null;
  nextTokenResponse = {
    status: 200,
    body: JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    }),
  };
  await db.delete(credentialVault);
  await db.delete(upstreamAccounts);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const MASTER_KEY = "a".repeat(64); // 32-byte hex key for tests

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

async function seedAccount(
  overrides: Partial<{
    failCount: number;
    status: string;
    schedulable: boolean;
  }> = {},
) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-oauth-account",
      platform: "anthropic",
      type: "oauth",
      schedulable: overrides.schedulable ?? true,
      status: overrides.status ?? "active",
      oauthRefreshFailCount: overrides.failCount ?? 0,
    })
    .returning();
  return acct!;
}

async function seedVault(
  accountId: string,
  credential: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  },
) {
  const plaintext = JSON.stringify({
    type: "oauth",
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_at: credential.expiresAt.toISOString(),
  });
  const sealed = encryptCredential({
    masterKeyHex: MASTER_KEY,
    accountId,
    plaintext,
  });
  await db.insert(credentialVault).values({
    accountId,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
    oauthExpiresAt: credential.expiresAt,
  });
}

function staleExpiresAt(now: number = Date.now()): Date {
  // expired 10 minutes ago
  return new Date(now - 10 * 60 * 1000);
}

function freshExpiresAt(now: number = Date.now()): Date {
  // expires in 30 minutes
  return new Date(now + 30 * 60 * 1000);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("maybeRefreshOAuth", () => {
  it("1. fast path: not yet expiring → returns current unchanged; no token request, no DB update", async () => {
    const acct = await seedAccount();
    const expiresAt = freshExpiresAt();
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    });

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    };

    const result = await maybeRefreshOAuth(
      db as never,
      redis,
      acct.id,
      currentCredential,
      {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      },
    );

    expect(result).toBe(currentCredential); // same object reference
    expect(lastTokenRequest).toBeNull();

    const [vaultRow] = await db
      .select({ rotatedAt: credentialVault.rotatedAt })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultRow!.rotatedAt).toBeNull();
  });

  it("2. winner: lock acquired, refresh succeeds, vault updated, account fail_count reset", async () => {
    const acct = await seedAccount({ failCount: 2 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 3600,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    const result = await maybeRefreshOAuth(
      db as never,
      redis,
      acct.id,
      currentCredential,
      {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 5,
        tokenUrl: tokenBaseUrl,
      },
    );

    expect(result.type).toBe("oauth");
    expect(result.accessToken).toBe("fresh-access-token");
    expect(result.refreshToken).toBe("fresh-refresh-token");
    expect(result.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 3500 * 1000,
    );

    const [vaultRow] = await db
      .select({
        oauthExpiresAt: credentialVault.oauthExpiresAt,
        rotatedAt: credentialVault.rotatedAt,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultRow!.oauthExpiresAt).not.toBeNull();
    expect(vaultRow!.oauthExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 3500 * 1000,
    );
    expect(vaultRow!.rotatedAt).not.toBeNull();

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        lastError: upstreamAccounts.oauthRefreshLastError,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(0);
    expect(acctRow!.lastError).toBeNull();
  });

  it("3. winner: token endpoint returns 400 invalid_grant → immediate auto-pause regardless of fail_count (issue #92)", async () => {
    // Issue #92 sub-task 2: invalid_grant means the refresh_token has been
    // rotated externally (Claude Code app on the same host, etc.) and is
    // unrecoverable until operator re-onboards. One strike → status=error,
    // schedulable=false, no point counting toward maxFail gradually.
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        lastError: upstreamAccounts.oauthRefreshLastError,
        status: upstreamAccounts.status,
        schedulable: upstreamAccounts.schedulable,
        tempUnschedulableReason: upstreamAccounts.tempUnschedulableReason,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    // Auto-paused immediately
    expect(acctRow!.status).toBe("error");
    expect(acctRow!.schedulable).toBe(false);
    expect(acctRow!.tempUnschedulableReason).toBe("oauth_invalid_grant");
    // failCount bumped to maxFail for audit visibility ("3+ failures" badge)
    expect(acctRow!.failCount).toBeGreaterThanOrEqual(3);
    expect(acctRow!.lastError).toBeTruthy();

    // Refresh lock must be released
    const lockKey = `oauth-refresh:${acct.id}`;
    const exists = await redis.exists(lockKey);
    expect(exists).toBe(0);
    // Backoff lock must be set so subsequent attempts skip
    const backoffExists = await redis.exists(`oauth-backoff:${acct.id}`);
    expect(backoffExists).toBe(1);
  });

  it("3a. 429 rate_limited → does NOT increment fail_count, sets exponential-backoff lock (issue #92)", async () => {
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 429,
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "slow down" },
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        status: upstreamAccounts.status,
        schedulable: upstreamAccounts.schedulable,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    // Account stays active — anthropic throttling is not the account's fault
    expect(acctRow!.failCount).toBe(0);
    expect(acctRow!.status).toBe("active");
    expect(acctRow!.schedulable).toBe(true);
    // But backoff lock must hold the next attempt off
    const backoffTtl = await redis.ttl(`oauth-backoff:${acct.id}`);
    expect(backoffTtl).toBeGreaterThan(0);
    expect(backoffTtl).toBeLessThanOrEqual(120); // base 60s, may grow
  });

  it("3b. backoff lock held → maybeRefreshOAuth short-circuits, returns currentCredential unchanged (issue #92)", async () => {
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    const redis = makeRedis();
    // Pre-set the lock as if a recent failure happened
    await redis.set(`oauth-backoff:${acct.id}`, "1", "EX", 60);

    // If anthropic were called this would 200 with a new token — but
    // the backoff lock should prevent that.
    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "WOULD-NOT-SEE-THIS",
        refresh_token: "ignored",
        expires_in: 3600,
      }),
    };

    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    const got = await maybeRefreshOAuth(
      db as never,
      redis,
      acct.id,
      currentCredential,
      {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      },
    );
    // Returned the original credential, didn't touch the upstream
    expect(got.accessToken).toBe("old-access");
    expect(got.refreshToken).toBe("old-refresh");
  });

  it("4. 3 consecutive failures → fail_count=3 >= maxFail=3 → account marked status='error', schedulable=false", async () => {
    const acct = await seedAccount({ failCount: 2 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 500,
      body: JSON.stringify({ error: "server_error" }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        status: upstreamAccounts.status,
        schedulable: upstreamAccounts.schedulable,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(3);
    expect(acctRow!.status).toBe("error");
    expect(acctRow!.schedulable).toBe(false);
  });

  it("5. winner: token endpoint returns malformed JSON → OAuthRefreshError + recordFailure", async () => {
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = { status: 200, body: "not-valid-json{{" };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({ failCount: upstreamAccounts.oauthRefreshFailCount })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(1);
  });

  it("6. loser: lock held, winner releases after 500ms, loser re-reads vault and returns refreshed credential", async () => {
    const acct = await seedAccount();
    const staleExpiry = staleExpiresAt();
    const freshExpiry = freshExpiresAt();

    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    });

    const redis = makeRedis();
    const lockKey = `oauth-refresh:${acct.id}`;

    // Pre-set the lock so loser can't acquire it
    await redis.set(lockKey, "1", "EX", 30, "NX");

    // Schedule: after 500ms, update vault with fresh credential and release lock
    const refreshDelay = setTimeout(async () => {
      // Update vault with fresh credential
      const plaintext = JSON.stringify({
        type: "oauth",
        access_token: "winner-fresh-access",
        refresh_token: "winner-fresh-refresh",
        expires_at: freshExpiry.toISOString(),
      });
      const sealed = encryptCredential({
        masterKeyHex: MASTER_KEY,
        accountId: acct.id,
        plaintext,
      });
      await db
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt: freshExpiry,
          rotatedAt: new Date(),
        })
        .where(eq(credentialVault.accountId, acct.id));
      // Release lock
      await redis.del(lockKey);
    }, 500);

    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    };

    const result = await maybeRefreshOAuth(
      db as never,
      redis,
      acct.id,
      currentCredential,
      {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      },
    );

    clearTimeout(refreshDelay);

    // Loser did NOT call token server
    expect(lastTokenRequest).toBeNull();
    expect(result.accessToken).toBe("winner-fresh-access");
    expect(result.refreshToken).toBe("winner-fresh-refresh");
  });

  it("7. loser: lock auto-expires but vault NOT updated → throws OAuthRefreshError 'still expired'", async () => {
    const acct = await seedAccount();
    const staleExpiry = staleExpiresAt();

    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    });

    const redis = makeRedis();
    const lockKey = `oauth-refresh:${acct.id}`;

    // Pre-set lock with short TTL so it expires quickly
    await redis.set(lockKey, "1", "EX", 1, "NX");

    // Mock fast expiry: use a fast sleep and short poll max
    let pollCount = 0;
    const fastSleep = async (_ms: number) => {
      pollCount++;
      // After first poll, artificially expire the lock
      if (pollCount >= 1) {
        await redis.del(lockKey);
      }
    };

    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
        sleep: fastSleep,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).message).toMatch(/still expired/);
      return true;
    });
  });

  it("8. persisted credential is decryptable end-to-end", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "e2e-access-token",
        refresh_token: "e2e-refresh-token",
        expires_in: 7200,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    };

    await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
    });

    // Re-read vault raw and decrypt
    const [vaultRow] = await db
      .select({
        nonce: credentialVault.nonce,
        ciphertext: credentialVault.ciphertext,
        authTag: credentialVault.authTag,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));

    const plaintext = decryptCredential({
      masterKeyHex: MASTER_KEY,
      accountId: acct.id,
      sealed: {
        nonce: vaultRow!.nonce,
        ciphertext: vaultRow!.ciphertext,
        authTag: vaultRow!.authTag,
      },
    });
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    expect(parsed.access_token).toBe("e2e-access-token");
    expect(parsed.refresh_token).toBe("e2e-refresh-token");
    expect(typeof parsed.expires_at).toBe("string");
  });

  it("9. lock is released even when refresh throws (finally block)", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 500,
      body: JSON.stringify({ error: "internal_error" }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const lockKey = `oauth-refresh:${acct.id}`;
    const exists = await redis.exists(lockKey);
    expect(exists).toBe(0);
  });

  it("11. CAS conflict: persistRefresh with stale prevRotatedAt throws OAuthRefreshError and leaves vault unchanged", async () => {
    const acct = await seedAccount();
    const initialRotated = new Date("2026-04-20T00:00:00Z");
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // Manually set rotated_at to a known value
    await db
      .update(credentialVault)
      .set({ rotatedAt: initialRotated })
      .where(eq(credentialVault.accountId, acct.id));

    // Call persistRefresh with a stale prevRotatedAt that doesn't match the current DB value
    const stalePrev = new Date("1970-01-01T00:00:00Z");
    const staleFresh: Extract<
      import("../../src/runtime/resolveCredential.js").ResolvedCredential,
      { type: "oauth" }
    > = {
      type: "oauth",
      accessToken: "stale",
      refreshToken: "r",
      expiresAt: new Date(Date.now() + 3600_000),
    };

    await expect(
      persistRefresh(
        db as never,
        acct.id,
        staleFresh,
        MASTER_KEY,
        () => Date.now(),
        stalePrev,
      ),
    ).rejects.toThrow(/CAS conflict/);

    // Vault must be unchanged
    const [row] = await db
      .select({ rotatedAt: credentialVault.rotatedAt })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id))
      .limit(1);
    expect(row!.rotatedAt?.toISOString()).toBe(initialRotated.toISOString());
  });

  it("12. CAS happy path: persistRefresh with prevRotatedAt=null succeeds when rotated_at IS NULL", async () => {
    const acct = await seedAccount();
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // Confirm rotated_at starts as null
    const before = await readVaultRotatedAt(db as never, acct.id);
    expect(before).toBeNull();

    const fresh: Extract<
      import("../../src/runtime/resolveCredential.js").ResolvedCredential,
      { type: "oauth" }
    > = {
      type: "oauth",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: new Date(Date.now() + 3600_000),
    };

    await expect(
      persistRefresh(
        db as never,
        acct.id,
        fresh,
        MASTER_KEY,
        () => Date.now(),
        null,
      ),
    ).resolves.toBeUndefined();

    const after = await readVaultRotatedAt(db as never, acct.id);
    expect(after).not.toBeNull();
  });

  it("13. CAS happy path: persistRefresh with prevRotatedAt=X succeeds when rotated_at matches X; rotated_at advances", async () => {
    const acct = await seedAccount();
    const initialRotated = new Date("2026-01-01T00:00:00Z");
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await db
      .update(credentialVault)
      .set({ rotatedAt: initialRotated })
      .where(eq(credentialVault.accountId, acct.id));

    const fresh: Extract<
      import("../../src/runtime/resolveCredential.js").ResolvedCredential,
      { type: "oauth" }
    > = {
      type: "oauth",
      accessToken: "newer-access",
      refreshToken: "newer-refresh",
      expiresAt: new Date(Date.now() + 3600_000),
    };

    const nowMs = Date.now();
    await expect(
      persistRefresh(
        db as never,
        acct.id,
        fresh,
        MASTER_KEY,
        () => nowMs,
        initialRotated,
      ),
    ).resolves.toBeUndefined();

    const after = await readVaultRotatedAt(db as never, acct.id);
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(initialRotated.getTime());
  });

  it("10. token endpoint receives correct body { grant_type, refresh_token, client_id }", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "my-access",
      refreshToken: "my-refresh-token-123",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "newer-access",
        refresh_token: "newer-refresh",
        expires_in: 3600,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "my-access",
      refreshToken: "my-refresh-token-123",
      expiresAt,
    };

    const testClientId = "test-client-id-override";
    await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
      clientId: testClientId,
    });

    expect(lastTokenRequest).not.toBeNull();
    const body = JSON.parse(lastTokenRequest!.body) as Record<string, unknown>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("my-refresh-token-123");
    expect(body.client_id).toBe(testClientId);
  });
});
