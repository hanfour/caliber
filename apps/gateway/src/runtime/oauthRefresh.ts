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
import {
  readKeychainBundle as defaultKeychainReader,
  type KeychainBundle,
  type KeychainReader,
} from "./keychainReader.js";

const LOCK_TTL_SEC = 30;
const POLL_INTERVAL_MS = 200;
const POLL_MAX_MS = 30_000;

export const DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Default refresh endpoint for Claude Max OAuth bundles. Anthropic has
// shuffled this between api.anthropic.com → console.anthropic.com → in
// some recent docs platform.claude.com; the path also gained a `/v1/`.
// Operators can override via env GATEWAY_ANTHROPIC_OAUTH_TOKEN_URL when
// it moves again. Wrong URL surfaces as upstream 404 not_found_error
// → fail_count increments → account auto-paused on the third failure.
export const DEFAULT_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

/**
 * Classification of OAuth refresh failures (issue #92).
 *
 * - `rate_limited`: anthropic returned 429 — transient, don't count
 *   against fail_count, back off and retry later.
 * - `invalid_grant`: refresh_token rotated externally (Claude Code app
 *   on the same host beat us to a refresh, rotating ours). One strike
 *   → immediate auto-pause; account needs operator re-onboard.
 * - `transient`: network errors, 5xx — count toward fail_count with
 *   the existing 3-strike auto-pause.
 * - `unknown`: anything else (4xx ≠ 400/429, parse errors, malformed
 *   responses) — count toward fail_count; conservative default.
 */
export type OAuthRefreshErrorKind =
  | "rate_limited"
  | "invalid_grant"
  | "transient"
  | "unknown";

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly kind: OAuthRefreshErrorKind = "unknown",
    /** When kind=rate_limited, hint how long to wait (seconds). */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

/**
 * Heuristic backoff for `rate_limited` failures. Doubles per consecutive
 * 429: 60s → 120s → 240s, capped at 600s. Reset to 60s after any
 * successful refresh (existing persistRefresh zeros oauth_refresh_fail_count
 * which is also our 429 counter — we don't track separately).
 */
const RATE_LIMITED_BACKOFF_BASE_SEC = 60;
const RATE_LIMITED_BACKOFF_MAX_SEC = 600;
function rateLimitedBackoffSec(consecutiveCount: number): number {
  return Math.min(
    RATE_LIMITED_BACKOFF_BASE_SEC * Math.pow(2, Math.max(0, consecutiveCount - 1)),
    RATE_LIMITED_BACKOFF_MAX_SEC,
  );
}

/**
 * Default backoff for non-rate-limited failures (transient / unknown /
 * invalid_grant). Issue #92 sub-task 4: even one failure should hold
 * inline-refresh attempts off the upstream for at least this long.
 */
const POST_FAILURE_LOCK_SEC = 60;

/**
 * Classifier — maps anthropic OAuth endpoint status + body into one
 * of our error kinds. Conservative: anything we don't recognize falls
 * back to `unknown` (which still counts toward fail_count).
 *
 * Anthropic body shapes observed:
 * - 429 → \`{"error":{"type":"rate_limit_error","message":...}}\`
 * - 400 → \`{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}\`
 *   (note: bare-string error field, not the object shape, matches OAuth 2.0 spec)
 * - 5xx → arbitrary; treat as transient
 */
function classifyOAuthErrorBody(
  status: number,
  body: string,
): OAuthRefreshErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  // 4xx — peek at body for invalid_grant
  if (body.includes("invalid_grant") || body.includes("Refresh token not found")) {
    return "invalid_grant";
  }
  // Network-level errors (caught upstream of the response body) get
  // mapped via classifyThrownError below; here we only see HTTP-level
  // failures.
  return "unknown";
}

/**
 * Classifier for thrown errors (network / DNS / abort) before we
 * have an HTTP response. Maps undici/node ECONN* + timeout codes to
 * `transient` so they back off but don't trip auto-pause as
 * aggressively as a 4xx would suggest.
 */
function classifyThrownError(err: unknown): OAuthRefreshErrorKind {
  if (err && typeof err === "object") {
    const code = (err as { code?: string }).code;
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_SOCKET"
    ) {
      return "transient";
    }
  }
  return "unknown";
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
  /**
   * `host:port` of the aide-keychain-helper TCP server. When set,
   * `maybeRefreshOAuth` consults the host Keychain *before* calling
   * the anthropic OAuth endpoint — the Claude Code app on the same
   * host may have already rotated the bundle, in which case aide
   * just inherits the new tokens for free (no upstream call, no
   * race). Only falls back to anthropic refresh when the keychain
   * bundle is also stale or unavailable. See issue #93 / option B'.
   */
  keychainEndpoint?: string;
  /** Path to the bearer token file inside the container. */
  keychainTokenPath?: string;
  /**
   * Test-only injection: replace the keychain reader with a fake.
   * Production code passes `keychainEndpoint` and the default
   * `readKeychainBundle` function gets used.
   */
  keychainReader?: KeychainReader;
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Time source for tests. */
  now?: () => number;
  /** Pino-style logger. Optional — used to log keychain re-read outcomes. */
  logger?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
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
 *
 * Issue #92 sub-task 4: also short-circuits if a post-failure backoff
 * lock is held — returns currentCredential unchanged so the caller
 * sends the (possibly stale) access_token through. If upstream 401s
 * the request fails normally; if it doesn't, we get free latency
 * relief during retry storms.
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

  // Sub-task 4: post-failure backoff lock. If we recently failed,
  // skip the refresh attempt entirely until the TTL expires. Caller
  // proceeds with the current (possibly stale) credential.
  const backoffKey = keys.oauthBackoff(accountId);
  const inBackoff = await redis.exists(backoffKey);
  if (inBackoff === 1) {
    return currentCredential;
  }

  const lockKey = keys.oauthRefresh(accountId);
  // SET NX EX returns "OK" on success, null on contention
  const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SEC, "NX");

  if (acquired === "OK") {
    try {
      const prevRotatedAt = await readVaultRotatedAt(db, accountId);

      // Issue #93 option B': consult the host Keychain before
      // calling anthropic. If the Claude Code app on the same host
      // already rotated the bundle, we inherit the new tokens for
      // free — no upstream call, no rotation race. Only proceed to
      // performRefresh when the keychain bundle is also stale or
      // unavailable.
      const fromKeychain = await maybeUseKeychainBundle({
        opts,
        currentRefreshToken: currentCredential.refreshToken,
        leadMs,
        now,
      });
      if (fromKeychain) {
        await persistRefresh(
          db,
          accountId,
          fromKeychain,
          opts.masterKeyHex,
          now,
          prevRotatedAt,
        );
        opts.logger?.info?.(
          { accountId, source: "keychain", expiresAt: fromKeychain.expiresAt },
          "oauth refresh: inherited rotated bundle from host keychain",
        );
        return fromKeychain;
      }

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
      await recordFailure(db, redis, accountId, err, opts.maxFail, now);
      throw new OAuthRefreshError(
        `oauth refresh failed for account ${accountId}`,
        err,
        err instanceof OAuthRefreshError ? err.kind : "unknown",
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
 *
 */
export async function performRefresh(input: {
  currentRefreshToken: string;
  tokenUrl: string;
  clientId: string;
  now?: () => number;
}): Promise<Extract<ResolvedCredential, { type: "oauth" }>> {
  const now = input.now ?? Date.now;
  let res;
  try {
    res = await request(input.tokenUrl, {
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
  } catch (err) {
    // Network-level failure (DNS, refused, timeout) — never reaches the
    // response-body classifier below. Map directly.
    throw new OAuthRefreshError(
      `token endpoint network error: ${err instanceof Error ? err.message : String(err)}`,
      err,
      classifyThrownError(err),
    );
  }

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const kind = classifyOAuthErrorBody(res.statusCode, text);
    const retryAfterRaw = res.headers["retry-after"];
    const retryAfterSec =
      typeof retryAfterRaw === "string"
        ? parseInt(retryAfterRaw, 10)
        : undefined;
    throw new OAuthRefreshError(
      `token endpoint ${res.statusCode}: ${text.slice(0, 200)}`,
      undefined,
      kind,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
    );
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthRefreshError(
      `token endpoint returned non-JSON: ${text.slice(0, 200)}`,
      undefined,
      "unknown",
    );
  }
  if (
    !parsed.access_token ||
    !parsed.refresh_token ||
    typeof parsed.expires_in !== "number"
  ) {
    throw new OAuthRefreshError(
      "token response missing required fields",
      undefined,
      "unknown",
    );
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
 *
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
 * Records an OAuth refresh failure with kind-aware semantics (issue #92).
 *
 * Branches on the error kind:
 *
 * - `rate_limited` (429): does NOT increment fail_count. Sets a Redis
 *   backoff lock (60→120→240→…s, doubling per consecutive 429) so
 *   subsequent requests in the lead window skip refresh entirely
 *   until the lock expires. This stops aide from feedback-looping
 *   into anthropic's rate limiter and prevents transient throttling
 *   from auto-pausing the account.
 *
 * - `invalid_grant` (400 with that error code): immediate auto-pause
 *   regardless of fail_count. Refresh_token has been rotated externally
 *   (Claude Code app on the same host beat us); no amount of retrying
 *   will help — operator must re-onboard. Sets `status='error'`,
 *   `schedulable=false`, and `temp_unschedulable_reason='oauth_invalid_grant'`
 *   for UI surfacing. Also sets the standard backoff lock so the cron
 *   worker doesn't immediately retry either.
 *
 * - `transient` / `unknown`: existing behaviour. Increments fail_count,
 *   auto-pauses at maxFail. Also sets a 60s backoff lock to prevent
 *   inline-refresh hammering.
 *
 *
 *
 * Note: signature changed in #92 to accept `redis` for the backoff
 * lock. Cron worker callers also updated.
 */
export async function recordFailure(
  db: Database,
  redis: Redis,
  accountId: string,
  err: unknown,
  maxFail: number,
  now: () => number,
): Promise<void> {
  // Strip credential-shaped substrings before persisting — upstream OAuth
  // 401/400 bodies sometimes echo back the failing token verbatim, and we
  // don't want that landing in oauth_refresh_last_error / audit logs.
  const message = safeErrorMessage(err);
  const kind = err instanceof OAuthRefreshError ? err.kind : "unknown";

  const [row] = await db
    .select({
      failCount: upstreamAccounts.oauthRefreshFailCount,
    })
    .from(upstreamAccounts)
    .where(eq(upstreamAccounts.id, accountId))
    .limit(1);
  const prevFailCount = row?.failCount ?? 0;

  const update: Record<string, unknown> = {
    oauthRefreshLastError: message.slice(0, 1000),
    oauthRefreshLastRunAt: new Date(now()),
    updatedAt: new Date(now()),
  };

  let backoffSec = POST_FAILURE_LOCK_SEC;

  if (kind === "rate_limited") {
    // Don't increment fail_count — anthropic throttling is not the
    // account's fault. Use the rate-limit-specific exponential backoff
    // and prefer Retry-After header if anthropic provided one.
    const retryAfter =
      err instanceof OAuthRefreshError && err.retryAfterSec !== undefined
        ? err.retryAfterSec
        : undefined;
    backoffSec = retryAfter ?? rateLimitedBackoffSec(prevFailCount + 1);
  } else if (kind === "invalid_grant") {
    // Immediate auto-pause. The bundle is unrecoverable until operator
    // re-onboards; no point retrying or counting strikes.
    update.status = "error";
    update.schedulable = false;
    update.tempUnschedulableReason = "oauth_invalid_grant";
    update.tempUnschedulableUntil = new Date(now() + 365 * 24 * 60 * 60 * 1000);
    // Bump fail_count once for audit visibility (so admin UI sees
    // "3+ failures" rather than "0 failures" on a paused account).
    update.oauthRefreshFailCount = Math.max(prevFailCount + 1, maxFail);
  } else {
    // transient / unknown — preserve original behaviour
    const newCount = prevFailCount + 1;
    update.oauthRefreshFailCount = newCount;
    if (newCount >= maxFail) {
      update.status = "error";
      update.schedulable = false;
      update.tempUnschedulableReason = "oauth_refresh_exhausted";
      // TODO(part-7): emit gw_oauth_refresh_dead_total{account_id}
    }
  }

  await db
    .update(upstreamAccounts)
    .set(update)
    .where(eq(upstreamAccounts.id, accountId));

  // Always set the inline-refresh backoff lock, regardless of kind.
  // Even on auto-pause, a sibling request that read the credential
  // before the DB update could still try to refresh; the lock is
  // belt-and-suspenders.
  await redis
    .set(keys.oauthBackoff(accountId), "1", "EX", backoffSec)
    .catch(() => {});
}

/**
 * Issue #93 option B' helper. Asks the host keychain for the current
 * Claude Code OAuth bundle and decides whether it's worth using
 * instead of calling anthropic ourselves.
 *
 * Returns the keychain bundle (in the same shape `performRefresh`
 * returns) when **all** of the following are true:
 *
 * 1. `opts.keychainEndpoint` is configured (otherwise the keychain
 *    re-read feature is disabled — return null).
 * 2. The keychain reader returned a bundle (not null — covers socket
 *    missing, helper error, malformed response, etc.).
 * 3. The keychain's `refresh_token` differs from the one we currently
 *    hold (otherwise it's the same stale bundle and using it just
 *    pretends to refresh).
 * 4. The keychain's `access_token` is not within the lead window of
 *    expiry (otherwise it's just as stale as ours — call anthropic).
 *
 * Returns null in all other cases; caller falls through to the
 * existing `performRefresh` path.
 */
export async function maybeUseKeychainBundle(input: {
  opts: Pick<
    OAuthRefreshOptions,
    "keychainEndpoint" | "keychainTokenPath" | "keychainReader" | "logger"
  >;
  currentRefreshToken: string;
  leadMs: number;
  now: () => number;
}): Promise<Extract<ResolvedCredential, { type: "oauth" }> | null> {
  const { opts, currentRefreshToken, leadMs, now } = input;
  if (!opts.keychainEndpoint) return null;

  const reader = opts.keychainReader ?? defaultKeychainReader;
  let bundle: KeychainBundle | null;
  try {
    bundle = await reader({
      endpoint: opts.keychainEndpoint,
      tokenPath: opts.keychainTokenPath,
      logger: opts.logger,
    });
  } catch {
    // readKeychainBundle promises never to throw, but be defensive.
    return null;
  }
  if (!bundle) return null;

  // Same refresh_token = host hasn't rotated since our last read =
  // no point trying to use it.
  if (bundle.refreshToken === currentRefreshToken) return null;

  // Bundle expires inside the lead window or sooner = just as stale
  // as ours, no benefit. Call anthropic instead.
  if (bundle.expiresAt.getTime() <= now() + leadMs) return null;

  return {
    type: "oauth",
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
  };
}

/**
 * Reads the rotated_at timestamp from the credential vault for a given account.
 * Used to establish the CAS baseline before calling persistRefresh.
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
 *
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
