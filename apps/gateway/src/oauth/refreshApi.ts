import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import { upstreamAccounts } from "@aide/db";
import { maskCredentialMaterial } from "@aide/gateway-core";
import { eq } from "drizzle-orm";
import {
  OAuthLockTimeoutError,
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type Platform,
  type RefreshPolicy,
  type TokenSet,
} from "./types.js";
import { getTokenRefresher, type OAuthRegistry } from "./registry.js";
import { getPolicy } from "./policies.js";
import type { OAuthVault } from "./vault.js";

// Plan 5A §7.3 — unified `OAuthRefreshAPI`.  Single chokepoint that fronts
// every read of an OAuth access token in 5A:
//
//   - Hottest path: in-process cache hit (no DB, no decrypt) → return token.
//   - Hot path: vault row fresh (>5 min to expiry) → return + populate cache.
//   - Refresh path: cache miss / expiring within 5 min → acquire a Redis
//     lock keyed on the account, run the platform's TokenRefresher, write
//     atomically via the vault CAS, release the lock.
//   - Lock-held path: another worker is already refreshing.  Behaviour
//     depends on `RefreshPolicy.onLockHeld`:
//       * `wait_for_cache` → poll the vault for up to `lockWaitMs` and
//         return the freshly-rotated token when it arrives.
//       * `use_existing_token` → immediately return the cached token (or
//         throw `no_token_available` when there isn't one).
//   - Error path: TokenRefresher throws.  `OAuthRefreshTokenInvalid`
//     ALWAYS propagates (caller marks account oauth_invalid + alerts);
//     other errors honour `RefreshPolicy.onRefreshError`.
//
// In 5A only OpenAI is registered (PR 5).  Anthropic continues to refresh
// through the legacy monolithic `runtime/oauthRefresh.ts`; this class is
// therefore inert for Anthropic accounts until 5D refactors them in.

export interface OAuthRefreshAPIDeps {
  db: Database;
  vault: OAuthVault;
  redis: Redis;
  registry: OAuthRegistry;
  /** How long to poll the vault when another worker holds the lock. */
  lockWaitMs?: number;
  /**
   * In-process token cache TTL.  Hits within this window skip the DB
   * select + AES-GCM decrypt that `vault.peekAccessToken` does.  The
   * default (60s) is a conservative trade-off: long enough to absorb
   * burst traffic on the same account, short enough that a vault
   * mutation by another process becomes visible quickly.
   */
  cacheTtlMs?: number;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
  /** Test hook — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LOCK_WAIT_MS = 5_000;
/**
 * Lock TTL.  Sized at 60s for headroom against a slow upstream refresh;
 * typical OAuth token endpoints respond sub-2s, but cold starts /
 * network jitter can push individual refreshes into the 10-30s range.
 * If this expires before the holder's refresh finishes, a second worker
 * could acquire and re-refresh with the SAME refresh_token — and a
 * provider that rotates tokens on use will reject the second call as
 * `invalid_grant`, marking the account oauth_invalid even though the
 * first refresh succeeded.  60s is large enough to make that scenario
 * vanishingly rare without holding the lock long enough to deadlock a
 * stuck worker.
 */
const DEFAULT_LOCK_TTL_SEC = 60;
const POLL_INTERVAL_MS = 100;
/** Refresh when current token expires within this window. */
const REFRESH_LEADWAY_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 60_000;
/** Truncation cap for `error_message` writes — one log line's worth. */
const MAX_ERROR_MSG_LEN = 240;

const lockKeyFor = (accountId: string): string =>
  `oauth:refresh-lock:${accountId}`;
const failureKeyFor = (accountId: string): string =>
  `oauth:refresh-failure:${accountId}`;

interface MemCacheEntry {
  token: string;
  expiresAt: Date;
  cachedAt: number;
}

export class OAuthRefreshAPI {
  private readonly db: Database;
  private readonly vault: OAuthVault;
  private readonly redis: Redis;
  private readonly registry: OAuthRegistry;
  private readonly lockWaitMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokenCache = new Map<string, MemCacheEntry>();

  constructor(deps: OAuthRefreshAPIDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.redis = deps.redis;
    this.registry = deps.registry;
    this.lockWaitMs = deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Returns a valid access token for `accountId`.  Refreshes if the cached
   * token is expiring within ~5 min.  Concurrency is funnelled through a
   * Redis lock so at most one refresh runs per account at a time.
   */
  async getValidAccessToken(
    accountId: string,
  ): Promise<{ accessToken: string }> {
    // 1. In-process cache — skips DB + AES-GCM decrypt entirely.  This is
    //    the hottest path on a busy gateway where the same account serves
    //    many requests within the cache TTL.
    const memHit = this.peekMem(accountId);
    if (memHit) return { accessToken: memHit.token };

    // 2. Vault peek — DB select + decrypt.  Populate the in-process cache
    //    on the way out so subsequent requests skip both.
    const cached = await this.vault.peekAccessToken(accountId);
    if (cached && this.tokenStillFresh(cached.expiresAt)) {
      this.populateMem(accountId, cached.token, cached.expiresAt);
      return { accessToken: cached.token };
    }

    // 3. Refresh path — only here do we need platform / policy.  Loading
    //    the account row is deferred until now so the hot path stays at
    //    one DB read (vault.peek) instead of two.
    const account = await this.loadAccount(accountId);
    const policy = getPolicy(account.platform);

    const transient = await this.redis.get(failureKeyFor(accountId));
    if (transient && cached) {
      // Recent transient failure — honour failureTTL and serve the cached
      // token without hammering the upstream again.
      this.populateMem(accountId, cached.token, cached.expiresAt);
      return { accessToken: cached.token };
    }

    const lockKey = lockKeyFor(accountId);
    const lockAcquired = await this.redis.set(
      lockKey,
      "1",
      "EX",
      DEFAULT_LOCK_TTL_SEC,
      "NX",
    );

    if (!lockAcquired) {
      return this.handleLockHeld(accountId, policy, cached);
    }

    try {
      return await this.performRefresh(accountId, account.platform);
    } catch (err) {
      if (err instanceof OAuthRefreshTokenInvalid) {
        // Mask credential material — invalid_grant responses sometimes
        // echo the rejected refresh token verbatim, and we don't want
        // that landing in upstream_accounts.error_message.
        await this.markAccountOAuthInvalid(
          accountId,
          maskCredentialMaterial(err.message),
        );
        this.tokenCache.delete(accountId);
        throw err;
      }
      if (policy.onRefreshError === "use_existing_token" && cached) {
        await this.recordTransientFailure(accountId, policy.failureTTLMs);
        this.populateMem(accountId, cached.token, cached.expiresAt);
        return { accessToken: cached.token };
      }
      throw err;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /** Drop the in-process cache entry for one account. */
  invalidate(accountId: string): void {
    this.tokenCache.delete(accountId);
  }

  /** Drop every in-process cache entry. */
  clearCache(): void {
    this.tokenCache.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private peekMem(accountId: string): MemCacheEntry | null {
    const entry = this.tokenCache.get(accountId);
    if (!entry) return null;
    const now = this.now();
    if (entry.cachedAt + this.cacheTtlMs <= now) {
      this.tokenCache.delete(accountId);
      return null;
    }
    if (!this.tokenStillFresh(entry.expiresAt)) {
      // Token expiring soon — drop the entry so the refresh path runs.
      this.tokenCache.delete(accountId);
      return null;
    }
    return entry;
  }

  private populateMem(accountId: string, token: string, expiresAt: Date): void {
    this.tokenCache.set(accountId, {
      token,
      expiresAt,
      cachedAt: this.now(),
    });
  }

  private tokenStillFresh(expiresAt: Date): boolean {
    return expiresAt.getTime() > this.now() + REFRESH_LEADWAY_MS;
  }

  private async loadAccount(
    accountId: string,
  ): Promise<{ platform: Platform; type: string }> {
    const row = await this.db
      .select({
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, accountId))
      .limit(1)
      .then((rs) => rs[0]);
    if (!row) {
      throw new OAuthRefreshError(`account_not_found: ${accountId}`);
    }
    return {
      platform: row.platform as Platform,
      type: row.type,
    };
  }

  private async handleLockHeld(
    accountId: string,
    policy: RefreshPolicy,
    cached: Awaited<ReturnType<OAuthVault["peekAccessToken"]>>,
  ): Promise<{ accessToken: string }> {
    if (policy.onLockHeld === "wait_for_cache") {
      const after = await this.waitForCacheRefresh(accountId, this.lockWaitMs);
      if (after) {
        this.populateMem(accountId, after.token, after.expiresAt);
        return { accessToken: after.token };
      }
      throw new OAuthLockTimeoutError(accountId, this.lockWaitMs);
    }
    // 'use_existing_token'
    if (cached) {
      this.populateMem(accountId, cached.token, cached.expiresAt);
      return { accessToken: cached.token };
    }
    throw new OAuthRefreshError(`no_token_available: ${accountId}`);
  }

  private async waitForCacheRefresh(
    accountId: string,
    timeoutMs: number,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      const peek = await this.vault.peekAccessToken(accountId);
      if (peek && this.tokenStillFresh(peek.expiresAt)) {
        return { token: peek.token, expiresAt: peek.expiresAt };
      }
    }
    return null;
  }

  private async performRefresh(
    accountId: string,
    platform: Platform,
  ): Promise<{ accessToken: string }> {
    const refresher = getTokenRefresher(this.registry, platform);
    const loaded = await this.vault.loadForRefresh(accountId);
    if (!loaded) {
      throw new OAuthRefreshError(
        `vault_row_missing_for_refresh: ${accountId}`,
      );
    }
    const tokens: TokenSet = await refresher.refresh(loaded.refreshToken);
    await this.vault.replaceTokens(accountId, tokens, loaded.rotatedAt);
    // Clear any stale transient-failure marker so the next call can refresh
    // again immediately on success.
    await this.redis.del(failureKeyFor(accountId));
    this.populateMem(accountId, tokens.accessToken, tokens.expiresAt);
    return { accessToken: tokens.accessToken };
  }

  private async recordTransientFailure(
    accountId: string,
    ttlMs: number,
  ): Promise<void> {
    if (ttlMs <= 0) return;
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.set(failureKeyFor(accountId), "1", "EX", ttlSec);
  }

  private async markAccountOAuthInvalid(
    accountId: string,
    reason: string,
  ): Promise<void> {
    const truncated =
      reason.length > MAX_ERROR_MSG_LEN
        ? reason.slice(0, MAX_ERROR_MSG_LEN)
        : reason;
    await this.db
      .update(upstreamAccounts)
      .set({
        status: "oauth_invalid",
        schedulable: false,
        errorMessage: truncated,
        updatedAt: new Date(this.now()),
      })
      .where(eq(upstreamAccounts.id, accountId));
  }
}
