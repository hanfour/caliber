import type { Database } from "@caliber/db";
import {
  readCredential,
  readVaultRotatedAt,
  persistRefresh,
  OAuthRefreshError as LegacyOAuthRefreshError,
} from "../runtime/oauthRefresh.js";
import type { TokenSet } from "./types.js";

// Plan 5A §4.7 — vault facade.  4A's `apps/gateway/src/runtime/oauthRefresh.ts`
// already implements the encrypt/decrypt + CAS-on-rotated_at write semantics
// we need (see `readCredential`, `readVaultRotatedAt`, `persistRefresh`).
// Rather than duplicate or refactor that monolith mid-flight, this facade
// adapts those primitives to the shape `OAuthRefreshAPI` expects.
//
// 5D will reabsorb this facade once Anthropic's monolith is rewritten into
// the same 4-piece pattern (decision A11) and the legacy primitives can
// move into a single `vault.ts`.

export interface OAuthVaultPeek {
  /** Currently-stored access token (decrypted from credential_vault). */
  token: string;
  /** When the upstream-issued access token expires. */
  expiresAt: Date;
  /**
   * `credential_vault.rotated_at` snapshot at read time — must be threaded
   * back into `replaceTokens` for the CAS-on-write to refuse mid-flight
   * concurrent rotations.
   */
  rotatedAt: Date | null;
}

export interface OAuthVaultLoadForRefresh extends OAuthVaultPeek {
  /** Currently-stored refresh token, only required by `TokenRefresher`. */
  refreshToken: string;
}

export interface OAuthVault {
  /**
   * Read just the cached access token + its expiry.  Returns `null` when
   * the vault row is missing — callers treat that as "no credential, run
   * the interactive auth flow".  `rotatedAt` is included so subsequent
   * `replaceTokens` calls can do the CAS dance.
   */
  peekAccessToken(accountId: string): Promise<OAuthVaultPeek | null>;
  /**
   * Read the full credential set.  Used at refresh time when the access
   * token is expiring and we need the refresh_token to call the upstream.
   * Returns `null` when the vault row is missing.
   */
  loadForRefresh(accountId: string): Promise<OAuthVaultLoadForRefresh | null>;
  /**
   * Atomic replace of the access + refresh tokens.  `prevRotatedAt` MUST
   * come from the same `peekAccessToken` / `loadForRefresh` call that
   * returned the in-flight refresh_token; the underlying CAS rejects the
   * write if another writer rotated the row first.
   */
  replaceTokens(
    accountId: string,
    tokens: TokenSet,
    prevRotatedAt: Date | null,
  ): Promise<void>;
}

export interface CreateOAuthVaultDeps {
  db: Database;
  masterKeyHex: string;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

export function createOAuthVault(deps: CreateOAuthVaultDeps): OAuthVault {
  const now = deps.now ?? Date.now;

  async function peek(
    accountId: string,
  ): Promise<OAuthVaultLoadForRefresh | null> {
    let cred;
    try {
      cred = await readCredential(deps.db, accountId, deps.masterKeyHex);
    } catch (err) {
      if (err instanceof LegacyOAuthRefreshError) return null;
      throw err;
    }
    if (cred.type !== "oauth") {
      // readCredential already throws when the underlying row isn't oauth,
      // but narrow defensively in case its semantics change.
      throw new LegacyOAuthRefreshError(
        `expected oauth credential for ${accountId}; got ${cred.type}`,
      );
    }
    const rotatedAt = await readVaultRotatedAt(deps.db, accountId);
    return {
      token: cred.accessToken,
      expiresAt: cred.expiresAt,
      refreshToken: cred.refreshToken,
      rotatedAt,
    };
  }

  return {
    async peekAccessToken(accountId) {
      const full = await peek(accountId);
      if (!full) return null;
      return {
        token: full.token,
        expiresAt: full.expiresAt,
        rotatedAt: full.rotatedAt,
      };
    },
    async loadForRefresh(accountId) {
      return peek(accountId);
    },
    async replaceTokens(accountId, tokens, prevRotatedAt) {
      await persistRefresh(
        deps.db,
        accountId,
        {
          type: "oauth",
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
        deps.masterKeyHex,
        now,
        prevRotatedAt,
      );
    },
  };
}
