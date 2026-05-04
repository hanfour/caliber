import { eq, and, isNull } from "drizzle-orm";
import { request } from "undici";
import type { Redis } from "ioredis";
import { credentialVault, upstreamAccounts } from "@aide/db";
import type { Database } from "@aide/db";
import {
  encryptCredential,
  decryptCredential,
  safeErrorMessage,
} from "@aide/gateway-core";
import { keys } from "../redis/keys.js";
import type { ResolvedCredential } from "./resolveCredential.js";

const LOCK_TTL_SEC = 30;
const POLL_INTERVAL_MS = 200;
const POLL_MAX_MS = 30_000;

const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_TOKEN_URL = "https://api.anthropic.com/oauth/token";

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

export interface OAuthRefreshOptions {
  /** Master key for encrypting the new credential. */
  masterKeyHex: string;
  /** env.GATEWAY_OAUTH_REFRESH_LEAD_MIN — refresh if expiring within this many minutes. */
  leadMinutes: number;
  /** env.GATEWAY_OAUTH_MAX_FAIL — after this many consecutive failures, mark account 'error'. */
  maxFail: number;
  /** Override for tests. */
  tokenUrl?: string;
  /** Override for tests. */
  clientId?: string;
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Time source for tests. */
  now?: () => number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Refreshes the OAuth credential if necessary; returns the (possibly fresh) credential.
 * If `currentCredential.expiresAt > now + leadMinutes`, returns currentCredential unchanged.
 * Otherwise acquires a Redis lock and either refreshes (winner) or polls (loser).
 */
export async function maybeRefreshOAuth(
  db: Database,
  redis: Redis,
  accountId: string,
  currentCredential: Extract<ResolvedCredential, { type: "oauth" }>,
  opts: OAuthRefreshOptions,
): Promise<Extract<ResolvedCredential, { type: "oauth" }>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const leadMs = opts.leadMinutes * 60 * 1000;

  // Fast path: still fresh enough
  if (currentCredential.expiresAt.getTime() > now() + leadMs) {
    return currentCredential;
  }

  const lockKey = keys.oauthRefresh(accountId);
  // SET NX EX returns "OK" on success, null on contention
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SEC, "NX");

  if (acquired === "OK") {
    try {
      const prevRotatedAt = await readVaultRotatedAt(db, accountId);
      const fresh = await performRefresh({
        currentRefreshToken: currentCredential.refreshToken,
        tokenUrl: opts.tokenUrl ?? DEFAULT_TOKEN_URL,
        clientId: opts.clientId ?? DEFAULT_CLIENT_ID,
        now,
      });
      await persistRefresh(
        db,
        accountId,
        fresh,
        opts.masterKeyHex,
        now,
        prevRotatedAt,
      );
      return fresh;
    } catch (err) {
      await recordFailure(db, accountId, err, opts.maxFail, now);
      throw new OAuthRefreshError(
        `oauth refresh failed for account ${accountId}`,
        err,
      );
    } finally {
      await redis.del(lockKey).catch(() => {});
    }
  }

  // Loser: poll until winner releases the lock, then re-read vault
  const start = now();
  while (now() - start < POLL_MAX_MS) {
    await sleep(POLL_INTERVAL_MS);
    const stillLocked = await redis.exists(lockKey);
    if (stillLocked === 0) break;
  }

  // Re-read the (hopefully refreshed) credential
  const refreshed = await readCredential(db, accountId, opts.masterKeyHex);
  if (refreshed.type !== "oauth") {
    throw new OAuthRefreshError(
      `unexpected non-oauth credential after refresh for ${accountId}`,
    );
  }
  if (refreshed.expiresAt.getTime() <= now() + leadMs) {
    throw new OAuthRefreshError(
      `refresh lock released but token still expired for ${accountId}`,
    );
  }
  return refreshed;
}

/**
 * Calls the OAuth token endpoint with the given refresh token and returns the new credential.
 * Shared with the cron worker (oauthRefreshCron.ts).
 */
export async function performRefresh(input: {
  currentRefreshToken: string;
  tokenUrl: string;
  clientId: string;
  now?: () => number;
}): Promise<Extract<ResolvedCredential, { type: "oauth" }>> {
  const now = input.now ?? Date.now;
  const res = await request(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: input.currentRefreshToken,
      client_id: input.clientId,
    }),
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new OAuthRefreshError(
      `token endpoint ${res.statusCode}: ${text.slice(0, 200)}`,
    );
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthRefreshError(
      `token endpoint returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  if (
    !parsed.access_token ||
    !parsed.refresh_token ||
    typeof parsed.expires_in !== "number"
  ) {
    throw new OAuthRefreshError("token response missing required fields");
  }
  return {
    type: "oauth",
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: new Date(now() + parsed.expires_in * 1000),
  };
}

/**
 * Encrypts and persists a refreshed credential to the vault; resets fail counters on the account.
 * Uses Compare-And-Swap on rotated_at to prevent concurrent writers from overwriting a newer token.
 * Shared with the cron worker (oauthRefreshCron.ts).
 */
export async function persistRefresh(
  db: Database,
  accountId: string,
  credential: Extract<ResolvedCredential, { type: "oauth" }>,
  masterKeyHex: string,
  now: () => number,
  prevRotatedAt: Date | null,
): Promise<void> {
  const plaintext = JSON.stringify({
    type: "oauth",
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_at: credential.expiresAt.toISOString(),
  });
  const sealed = encryptCredential({ masterKeyHex, accountId, plaintext });

  const casCondition =
    prevRotatedAt === null
      ? isNull(credentialVault.rotatedAt)
      : eq(credentialVault.rotatedAt, prevRotatedAt);

  const result = await db
    .update(credentialVault)
    .set({
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      oauthExpiresAt: credential.expiresAt,
      rotatedAt: new Date(now()),
    })
    .where(and(eq(credentialVault.accountId, accountId), casCondition));

  if (
    typeof (result as { rowCount?: number }).rowCount === "number" &&
    (result as { rowCount: number }).rowCount === 0
  ) {
    throw new OAuthRefreshError(
      `CAS conflict on credential_vault for account ${accountId} — concurrent writer beat us`,
    );
  }

  await db
    .update(upstreamAccounts)
    .set({
      oauthRefreshFailCount: 0,
      oauthRefreshLastError: null,
      oauthRefreshLastRunAt: new Date(now()),
      updatedAt: new Date(now()),
    })
    .where(eq(upstreamAccounts.id, accountId));
}

/**
 * Increments the failure counter; marks account status='error' and schedulable=false at maxFail.
 * Shared with the cron worker (oauthRefreshCron.ts).
 */
export async function recordFailure(
  db: Database,
  accountId: string,
  err: unknown,
  maxFail: number,
  now: () => number,
): Promise<void> {
  // Strip credential-shaped substrings before persisting — upstream OAuth
  // 401/400 bodies sometimes echo back the failing token verbatim, and we
  // don't want that landing in oauth_refresh_last_error / audit logs.
  const message = safeErrorMessage(err);
  const [row] = await db
    .select({ failCount: upstreamAccounts.oauthRefreshFailCount })
    .from(upstreamAccounts)
    .where(eq(upstreamAccounts.id, accountId))
    .limit(1);
  const newCount = (row?.failCount ?? 0) + 1;
  const update: Record<string, unknown> = {
    oauthRefreshFailCount: newCount,
    oauthRefreshLastError: message.slice(0, 1000),
    oauthRefreshLastRunAt: new Date(now()),
    updatedAt: new Date(now()),
  };
  if (newCount >= maxFail) {
    update.status = "error";
    update.schedulable = false;
    // TODO(part-7): emit gw_oauth_refresh_dead_total{account_id}
  }
  await db
    .update(upstreamAccounts)
    .set(update)
    .where(eq(upstreamAccounts.id, accountId));
}

/**
 * Reads the rotated_at timestamp from the credential vault for a given account.
 * Used to establish the CAS baseline before calling persistRefresh.
 * Exported so the cron worker can use it without a separate query.
 */
export async function readVaultRotatedAt(
  db: Database,
  accountId: string,
): Promise<Date | null> {
  const row = await db
    .select({ rotatedAt: credentialVault.rotatedAt })
    .from(credentialVault)
    .where(eq(credentialVault.accountId, accountId))
    .limit(1)
    .then((r) => r[0]);
  return row?.rotatedAt ?? null;
}

/**
 * Reads and decrypts the credential vault row for a given account.
 * Shared with the cron worker (oauthRefreshCron.ts).
 */
export async function readCredential(
  db: Database,
  accountId: string,
  masterKeyHex: string,
): Promise<ResolvedCredential> {
  const row = await db
    .select({
      nonce: credentialVault.nonce,
      ciphertext: credentialVault.ciphertext,
      authTag: credentialVault.authTag,
    })
    .from(credentialVault)
    .where(eq(credentialVault.accountId, accountId))
    .limit(1)
    .then((r) => r[0]);
  if (!row) {
    throw new OAuthRefreshError(
      `credential vault row missing for account ${accountId}`,
    );
  }
  const plaintext = decryptCredential({
    masterKeyHex,
    accountId,
    sealed: {
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.authTag,
    },
  });
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  if (parsed.type !== "oauth") {
    throw new OAuthRefreshError(`expected oauth credential for ${accountId}`);
  }
  return {
    type: "oauth",
    accessToken: parsed.access_token as string,
    refreshToken: parsed.refresh_token as string,
    expiresAt: new Date(parsed.expires_at as string),
  };
}
