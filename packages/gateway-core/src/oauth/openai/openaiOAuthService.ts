import {
  generateCodeChallenge,
  generatePKCEVerifier,
  generateState,
} from "../pkce.js";
import { OAuthRefreshError, type OAuthService } from "../types.js";
import { OPENAI_CODEX_OAUTH } from "./codexConstants.js";
import { parseTokenResponse } from "./openaiTokenParser.js";

// Plan 5A §6 — interactive OAuth flow for OpenAI Codex CLI.  Implements
// the OAuthService interface (Part 4 types.ts).  Two operations:
//
//   - generateAuthURL: build the Codex authorize URL with PKCE S256
//     challenge + a fresh CSRF state token.  The caller persists `state`
//     and `codeVerifier` (e.g. in Redis-backed flow state) until the
//     user's browser redirects back with the auth code.
//   - exchangeCode: trade the authorization code for an initial TokenSet
//     against the Codex token endpoint.

const URLENCODED = "application/x-www-form-urlencoded";
/**
 * Per-request HTTP timeout.  Sub-2s is typical for healthy responses;
 * 15s leaves room for cold starts / network jitter without holding
 * the OAuthRefreshAPI Redis lock past its 60s TTL.
 */
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export interface OpenAIOAuthServiceDeps {
  /** Test hook — defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

export function createOpenAIOAuthService(
  deps: OpenAIOAuthServiceDeps = {},
): OAuthService {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  return {
    platform: "openai",

    async generateAuthURL(opts) {
      const codeVerifier = generatePKCEVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();
      const redirectURI =
        opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI;

      const url = new URL(OPENAI_CODEX_OAUTH.authorizeEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", OPENAI_CODEX_OAUTH.clientId);
      url.searchParams.set("redirect_uri", redirectURI);
      url.searchParams.set("scope", OPENAI_CODEX_OAUTH.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set(
        "code_challenge_method",
        OPENAI_CODEX_OAUTH.pkceMethod,
      );

      return { authUrl: url.toString(), state, codeVerifier, redirectURI };
    },

    async exchangeCode(opts) {
      const redirectURI =
        opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_OAUTH.clientId,
        code: opts.code,
        redirect_uri: redirectURI,
        code_verifier: opts.codeVerifier,
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
        // Network / DNS / abort.  Don't include `err.message` — it can
        // contain proxy chain / target-host info that's noisy when this
        // bubbles into upstream_accounts.error_message.
        const reason =
          err instanceof Error && err.name === "TimeoutError"
            ? "timeout"
            : "network";
        throw new OAuthRefreshError(
          `openai_oauth_exchange_${reason}`,
          "openai",
        );
      }

      if (!res.ok) {
        // Read + discard the body so the connection can be released.
        // Body intentionally NOT included in the thrown message: it can
        // contain proxy traceback / cookies / session ids that would
        // leak into upstream_accounts.error_message via
        // markAccountOAuthInvalid downstream.  Callers that want the
        // body for diagnosis should hook the structured logger.
        await res.text().catch(() => "");
        throw new OAuthRefreshError(
          `openai_oauth_exchange_failed: http_${res.status}`,
          "openai",
        );
      }

      let data: Record<string, unknown>;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch (_err) {
        // 200 + non-JSON happens occasionally with corp proxies that
        // serve maintenance HTML through the auth endpoint.
        throw new OAuthRefreshError(
          "openai_oauth_exchange_response_not_json",
          "openai",
        );
      }
      return parseTokenResponse(data, now);
    },
  };
}
