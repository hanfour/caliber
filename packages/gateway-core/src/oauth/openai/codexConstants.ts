/**
 * OpenAI Codex CLI OAuth constants — vendored from sub2api repo
 * (Wei-Shaw/sub2api), which itself vendored these from the official
 * Codex CLI npm package (`@openai/codex`).
 *
 * Source paths:
 *   - sub2api `internal/pkg/openai/oauth.go:19-26`
 *   - Codex CLI auth flow code (closed-source npm package; client_id is
 *     observable in network traces and is the same value any Codex CLI
 *     user transmits)
 *
 * Vendored on: 2026-04-28
 *
 * Re-vendor process: when the Codex CLI ships a new client_id (rare but
 * possible if OpenAI rotates app credentials), bump these constants in
 * one PR and re-test the OAuth flow end-to-end.  Document the change in
 * docs/runbooks/openai-oauth-vendor-update.md.
 */
export const OPENAI_CODEX_OAUTH = {
  /** OAuth client_id of the Codex CLI app, registered with OpenAI. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  /** Authorization endpoint used by `OAuthService.generateAuthURL`. */
  authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
  /** Token endpoint used by `exchangeCode` and `TokenRefresher.refresh`. */
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  /**
   * Default redirect URI — loopback per design A2.  The Codex CLI binds
   * a local listener on port 1455.  Admins running the OAuth flow from
   * the gateway host point their browser at this URL after auth.
   */
  defaultRedirectURI: "http://localhost:1455/auth/callback",
  /**
   * Scopes requested at authorization time.  `offline_access` is required
   * to receive a refresh_token (otherwise the access token can't be
   * renewed without re-authorising).
   */
  scopes: ["openid", "email", "profile", "offline_access"],
  /**
   * Space-separated scopes used when the refresh endpoint requires the
   * scope to be reasserted on rotation.  Same set as `scopes`, just
   * pre-joined for `application/x-www-form-urlencoded` posting.
   */
  refreshScopes: "openid email profile offline_access",
  /** PKCE method per design A3 — RFC 7636 S256. */
  pkceMethod: "S256" as const,
  /**
   * Approximate lifetime of the access_token issued by OpenAI Codex
   * OAuth (1 hour, observed empirically per design A4).  The actual
   * expiry is derived from `expires_in` in each token response — these
   * constants are reference values for documentation only.
   */
  approxAccessLifetimeSec: 60 * 60,
  /** Approximate lifetime of the refresh_token (~30 days, observed). */
  approxRefreshLifetimeSec: 30 * 24 * 60 * 60,
} as const;

/** OpenAI inference API base — used by `/v1/responses` upstream routing. */
export const OPENAI_API_BASE = "https://api.openai.com";
/**
 * ChatGPT subscription metadata API.  Used by `fetchPlanType` (Part 10)
 * to discover the OAuth account's subscription tier (`plan_type`) via
 * an ImpersonateChrome HTTP call — never the inference hot path.
 */
export const CHATGPT_BACKEND_API = "https://chatgpt.com/backend-api";
