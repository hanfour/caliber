import {
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type TokenRefresher,
} from "../types.js";
import {
  OPENAI_CODEX_OAUTH,
  parseTokenResponse,
} from "@caliber/gateway-core/oauth";

// Plan 5A §6.5 — OpenAI Codex token refresher.  Implements the
// TokenRefresher interface for use by `OAuthRefreshAPI`.
//
// Strict response contract: OpenAI's refresh-grant response always
// echoes a (possibly rotated) `refresh_token` alongside the new
// `access_token` and `expires_in`.  parseTokenResponse enforces this,
// so when refresh succeeds we ALWAYS have a fresh refresh_token to
// store — there is no "keep the old one" branch.  Decision A4 says
// rotation IS supported (the upstream chooses whether to issue a
// new token); the contract here is "if upstream issues anything,
// it includes a refresh_token".
//
// Failure handling:
//   - HTTP 400 / 401 with `invalid_grant` in the body → throws
//     OAuthRefreshTokenInvalid (always propagates regardless of
//     RefreshPolicy; account is marked oauth_invalid).
//   - Other 4xx / 5xx → OAuthRefreshError; the RefreshPolicy decides
//     whether to fall back to the cached access token (tolerant) or
//     bubble (strict).
//   - Network / timeout / DNS failure → OAuthRefreshError with a
//     `_network` / `_timeout` suffix.

const URLENCODED = "application/x-www-form-urlencoded";
/** Mirrors openaiOAuthService — see comment there. */
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export interface OpenAITokenRefresherDeps {
  /** Test hook — defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

export function createOpenAITokenRefresher(
  deps: OpenAITokenRefresherDeps = {},
): TokenRefresher {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  return {
    platform: "openai",

    async refresh(refreshToken) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_CODEX_OAUTH.clientId,
        refresh_token: refreshToken,
        scope: OPENAI_CODEX_OAUTH.refreshScopes,
      });

      let res: Response;
      try {
        res = await httpFetch(OPENAI_CODEX_OAUTH.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": URLENCODED },
          body,
          signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === "TimeoutError"
            ? "timeout"
            : "network";
        throw new OAuthRefreshError(
          `openai_oauth_refresh_${reason}`,
          "openai",
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (isInvalidGrant(res.status, text)) {
          // invalid_grant marker is structured + non-sensitive — safe to
          // include.  Anything else from the body stays out of the
          // error message (see openaiOAuthService.ts comment).
          throw new OAuthRefreshTokenInvalid(
            "openai_oauth_invalid_grant",
            "openai",
          );
        }
        throw new OAuthRefreshError(
          `openai_oauth_refresh_failed: http_${res.status}`,
          "openai",
        );
      }

      let data: Record<string, unknown>;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch (_err) {
        throw new OAuthRefreshError(
          "openai_oauth_refresh_response_not_json",
          "openai",
        );
      }
      return parseTokenResponse(data, now);
    },
  };
}

/**
 * RFC 6749 `invalid_grant` detection.  OpenAI's auth endpoint returns
 * either a JSON body `{ "error": "invalid_grant", ... }` or a plain-text
 * response containing the marker — we accept both.
 */
function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  if (body.includes('"error":"invalid_grant"')) return true;
  if (body.includes('"error": "invalid_grant"')) return true;
  if (body.includes("invalid_grant")) return true;
  return false;
}
