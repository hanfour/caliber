// Claude Max / Claude Code OAuth constants. clientId + tokenEndpoint are
// known from the existing refresh path; authorizeEndpoint + scopes +
// manual redirect are best-known defaults (Claude Code env docs) and are
// env-overridable — confirm with one live OAuth before enabling (Task 15).

export interface AnthropicOAuthConstants {
  clientId: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  defaultRedirectURI: string;
  scopes: string[];
  pkceMethod: "S256";
}

export const ANTHROPIC_OAUTH_DEFAULTS: AnthropicOAuthConstants = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeEndpoint: "https://claude.ai/oauth/authorize",
  tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  defaultRedirectURI: "https://console.anthropic.com/oauth/code/callback",
  // Match Claude Code's scope set exactly. claude.ai grants against the
  // client's registered scopes; the full set is what the official CLI requests
  // and is confirmed to grant (live OAuth 2026-06-09). Override via
  // ANTHROPIC_OAUTH_SCOPES to trim if a narrower set is desired.
  scopes: [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  pkceMethod: "S256",
};

export interface AnthropicOAuthEnv {
  ANTHROPIC_OAUTH_AUTHORIZE_URL?: string;
  ANTHROPIC_OAUTH_TOKEN_URL?: string;
  ANTHROPIC_OAUTH_REDIRECT_URI?: string;
  ANTHROPIC_OAUTH_SCOPES?: string;
}

export function resolveAnthropicConstants(
  env: AnthropicOAuthEnv,
): AnthropicOAuthConstants {
  return {
    ...ANTHROPIC_OAUTH_DEFAULTS,
    authorizeEndpoint:
      env.ANTHROPIC_OAUTH_AUTHORIZE_URL ??
      ANTHROPIC_OAUTH_DEFAULTS.authorizeEndpoint,
    tokenEndpoint:
      env.ANTHROPIC_OAUTH_TOKEN_URL ?? ANTHROPIC_OAUTH_DEFAULTS.tokenEndpoint,
    defaultRedirectURI:
      env.ANTHROPIC_OAUTH_REDIRECT_URI ??
      ANTHROPIC_OAUTH_DEFAULTS.defaultRedirectURI,
    scopes: env.ANTHROPIC_OAUTH_SCOPES
      ? env.ANTHROPIC_OAUTH_SCOPES.split(/\s+/).filter(Boolean)
      : ANTHROPIC_OAUTH_DEFAULTS.scopes,
  };
}
