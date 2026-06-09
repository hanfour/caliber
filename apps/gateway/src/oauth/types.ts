// Plan 5A Part 4 — 4-piece OAuth pattern (per design §7.1, X3 +
// sub2api wire.go:55-130).  Each platform implements a triple of
// OAuthService / TokenProvider / TokenRefresher under one shared
// RefreshPolicy.  The unified `OAuthRefreshAPI` (refreshApi.ts) glues
// them together via Redis-backed lock arbitration so background scans
// and on-demand fetches share refresh work without races.
//
// In 5A only OpenAI is implemented (Part 5).  Anthropic stays on the
// existing monolithic `apps/gateway/src/runtime/oauthRefresh.ts` until
// 5D refactors it into the same shape (decision A11).

// The interactive-flow contracts now live in gateway-core/oauth; re-export
// them so existing gateway consumers (refresher / refreshApi / runtime)
// keep importing from "../types.js" unchanged.
export {
  type Platform,
  type TokenSet,
  type OAuthService,
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
} from "@caliber/gateway-core/oauth";
import type { Platform, TokenSet } from "@caliber/gateway-core/oauth";
// `OAuthLockTimeoutError` (below) extends `OAuthRefreshError`, so we also
// need it as a local value binding — a re-export alone is not in scope here.
import { OAuthRefreshError } from "@caliber/gateway-core/oauth";

/**
 * 2. TokenProvider — hot-path access-token fetcher.  Called from request
 * handlers; returns a token that's still within its expiry window.  The
 * implementation owns whatever cache + refresh policy is appropriate
 * for the platform (typically delegates to `OAuthRefreshAPI`).
 */
export interface TokenProvider {
  platform: Platform;
  getAccessToken(accountId: string): Promise<{ accessToken: string }>;
  /** Force the next call for `accountId` to skip any in-process cache. */
  invalidate(accountId: string): void;
}

/**
 * 3. TokenRefresher — the plain executor that hits the platform's token
 * endpoint with a refresh_token and returns a new TokenSet.  Pure
 * function modulo the HTTP call; no caching / locking / persistence.
 * `OAuthRefreshAPI` orchestrates around it.
 */
export interface TokenRefresher {
  platform: Platform;
  refresh(refreshToken: string): Promise<TokenSet>;
}

/**
 * 4. RefreshPolicy — per-platform tunables that drive `OAuthRefreshAPI`'s
 * behaviour on the two failure axes:
 *
 *   - `onRefreshError`: when the refresh HTTP call itself errored
 *     (5xx, network, etc — NOT `invalid_grant`).  Tolerant platforms
 *     (Anthropic / OpenAI) reuse the existing access token and bump a
 *     short TTL counter; strict platforms (Gemini / Antigravity) bubble
 *     the error so callers fail fast.
 *   - `onLockHeld`: when another process is already refreshing this
 *     account.  Tolerant platforms wait for the refreshed token to
 *     appear in cache; strict platforms use the existing token.
 *
 * `failureTTLMs` is how long a transient failure should suppress
 * re-attempts (0 = retry every call).
 */
export type RefreshErrorAction = "use_existing_token" | "return_error";
export type LockHeldAction = "wait_for_cache" | "use_existing_token";

export interface RefreshPolicy {
  platform: Platform;
  onRefreshError: RefreshErrorAction;
  onLockHeld: LockHeldAction;
  failureTTLMs: number;
}

// ── Error classes ────────────────────────────────────────────────────────────
//
// `OAuthRefreshError` / `OAuthRefreshTokenInvalid` now live in
// gateway-core/oauth and are re-exported at the top of this file.  Each
// platform's TokenRefresher MUST throw `OAuthRefreshTokenInvalid` when the
// upstream returns an `invalid_grant` (or platform equivalent) — this is
// the only error that `OAuthRefreshAPI` always propagates regardless of
// `RefreshPolicy.onRefreshError`, so the account can be marked
// `oauth_invalid` and operators alerted.

/**
 * Subset of `OAuthRefreshAPI` that `TokenProvider` implementations need.
 * Splitting it out as an interface so unit tests can fake the dep
 * without instantiating the full class through the cast-via-unknown
 * workaround.  The concrete `OAuthRefreshAPI` (refreshApi.ts) implements
 * this implicitly via its public surface.
 */
export interface RefreshApiLike {
  getValidAccessToken(accountId: string): Promise<{ accessToken: string }>;
  invalidate(accountId: string): void;
  clearCache(): void;
}

export class OAuthLockTimeoutError extends OAuthRefreshError {
  constructor(
    public readonly accountId: string,
    public readonly waitedMs: number,
  ) {
    super(`oauth_lock_timeout: account ${accountId} after ${waitedMs}ms`);
    this.name = "OAuthLockTimeoutError";
  }
}
