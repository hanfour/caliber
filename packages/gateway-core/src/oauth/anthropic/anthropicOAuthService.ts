import {
  generateCodeChallenge,
  generatePKCEVerifier,
  generateState,
} from "../pkce.js";
import { OAuthRefreshError, type OAuthService } from "../types.js";
import type { AnthropicOAuthConstants } from "./anthropicConstants.js";
import { parseAnthropicTokenResponse } from "./anthropicTokenParser.js";

const JSON_CT = "application/json";
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export interface AnthropicOAuthServiceDeps {
  constants: AnthropicOAuthConstants;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createAnthropicOAuthService(
  deps: AnthropicOAuthServiceDeps,
): OAuthService {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const c = deps.constants;

  return {
    platform: "anthropic",

    async generateAuthURL(opts) {
      const codeVerifier = generatePKCEVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();
      const redirectURI = opts.redirectURI ?? c.defaultRedirectURI;
      const url = new URL(c.authorizeEndpoint);
      // Claude Code's OAuth uses the manual copy/paste flow: `code=true` tells
      // claude.ai to display the authorization code on the callback page
      // instead of round-tripping it through a local server. Omitting it makes
      // claude.ai reject the post-consent grant with "Invalid request format"
      // (confirmed via live OAuth 2026-06-09).
      url.searchParams.set("code", "true");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", c.clientId);
      url.searchParams.set("redirect_uri", redirectURI);
      url.searchParams.set("scope", c.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", c.pkceMethod);
      return { authUrl: url.toString(), state, codeVerifier, redirectURI };
    },

    async exchangeCode(opts) {
      const redirectURI = opts.redirectURI ?? c.defaultRedirectURI;
      let res: Response;
      try {
        res = await httpFetch(c.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": JSON_CT },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: c.clientId,
            code: opts.code,
            redirect_uri: redirectURI,
            code_verifier: opts.codeVerifier,
          }),
          signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === "TimeoutError"
            ? "timeout"
            : "network";
        throw new OAuthRefreshError(
          `anthropic_oauth_exchange_${reason}`,
          "anthropic",
        );
      }
      if (!res.ok) {
        // Read + discard the body so the connection releases. Body is
        // intentionally NOT included in the thrown message: it can carry
        // proxy traceback / cookies / session ids that would leak into
        // upstream_accounts.error_message downstream. Hook the structured
        // logger if the body is needed for diagnosis.
        await res.text().catch(() => "");
        throw new OAuthRefreshError(
          `anthropic_oauth_exchange_failed: http_${res.status}`,
          "anthropic",
        );
      }
      let data: Record<string, unknown>;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch (_err) {
        throw new OAuthRefreshError(
          "anthropic_oauth_exchange_response_not_json",
          "anthropic",
        );
      }
      return parseAnthropicTokenResponse(data, now);
    },
  };
}
