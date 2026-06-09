import { OAuthRefreshError, type TokenSet } from "../types.js";

// Anthropic token endpoint returns the same {access_token, refresh_token,
// expires_in} shape as OpenAI; separate parser keeps platform-correct
// error codes.
export function parseAnthropicTokenResponse(
  data: Record<string, unknown>,
  now: () => number,
): TokenSet {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_missing_access_token", "anthropic");
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_missing_refresh_token", "anthropic");
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new OAuthRefreshError("anthropic_oauth_token_response_invalid_expires_in", "anthropic");
  }
  const tokenType = typeof data.token_type === "string" ? data.token_type : "Bearer";
  const scope = typeof data.scope === "string" ? data.scope : undefined;
  return { accessToken, refreshToken, expiresAt: new Date(now() + expiresIn * 1000), tokenType, scope };
}
