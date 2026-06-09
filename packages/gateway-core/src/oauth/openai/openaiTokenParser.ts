import { OAuthRefreshError, type TokenSet } from "../types.js";

// Plan 5A — pure parser for `application/json` token responses from
// https://auth.openai.com/oauth/token.  Shared by both
// `openaiOAuthService.exchangeCode` (initial code-grant) and
// `openaiTokenRefresher.refresh` (refresh grant).  Lives in its own
// module so neither caller has to import the other.

/**
 * Validate + project the JSON body returned by OpenAI's token endpoint
 * into a `TokenSet`.
 *
 * Strict shape contract: `access_token`, `refresh_token`, `expires_in`
 * are all REQUIRED (OpenAI's actual responses always populate these on
 * both grant types).  Throws `OAuthRefreshError` with a stable code on
 * any shape mismatch so the upstream `OAuthRefreshAPI` / completion
 * handler can surface them uniformly.
 */
export function parseTokenResponse(
  data: Record<string, unknown>,
  now: () => number,
): TokenSet {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_missing_access_token",
      "openai",
    );
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_missing_refresh_token",
      "openai",
    );
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_invalid_expires_in",
      "openai",
    );
  }

  const tokenType =
    typeof data.token_type === "string" ? data.token_type : "Bearer";
  const scope = typeof data.scope === "string" ? data.scope : undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now() + expiresIn * 1000),
    tokenType,
    scope,
  };
}
