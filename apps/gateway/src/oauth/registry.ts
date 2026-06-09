import type { OAuthService } from "@caliber/gateway-core/oauth";
import type { Platform, TokenProvider, TokenRefresher } from "./types.js";

// Plan 5A §7.3 — per-platform DI registry.  Each platform implementation
// (PR 5 OpenAI, 5B Gemini, 5C Antigravity) registers its 4-piece triple
// here at app boot.  The unified `OAuthRefreshAPI` (refreshApi.ts) reads
// from this registry to dispatch refresh / fetch operations to the right
// platform module.
//
// Anthropic stays UNREGISTERED in 5A.  Anthropic OAuth still flows
// through the legacy monolithic `apps/gateway/src/runtime/oauthRefresh.ts`
// until 5D refactors it into the same 4-piece shape (decision A11).

export interface OAuthRegistry {
  services: Partial<Record<Platform, OAuthService>>;
  refreshers: Partial<Record<Platform, TokenRefresher>>;
  providers: Partial<Record<Platform, TokenProvider>>;
}

export interface OAuthRegistryDeps {
  services?: Partial<Record<Platform, OAuthService>>;
  refreshers?: Partial<Record<Platform, TokenRefresher>>;
  providers?: Partial<Record<Platform, TokenProvider>>;
}

/**
 * Build an empty registry that platform modules register into.  In 5A this
 * is empty by default; PR 5 will inject openai's three pieces.
 */
export function createOAuthRegistry(
  deps: OAuthRegistryDeps = {},
): OAuthRegistry {
  return {
    services: { ...(deps.services ?? {}) },
    refreshers: { ...(deps.refreshers ?? {}) },
    providers: { ...(deps.providers ?? {}) },
  };
}

export function getOAuthService(
  registry: OAuthRegistry,
  platform: Platform,
): OAuthService {
  const svc = registry.services[platform];
  if (!svc) {
    throw new Error(`oauth_service_not_registered_for_platform: ${platform}`);
  }
  return svc;
}

export function getTokenRefresher(
  registry: OAuthRegistry,
  platform: Platform,
): TokenRefresher {
  const r = registry.refreshers[platform];
  if (!r) {
    throw new Error(
      `oauth_token_refresher_not_registered_for_platform: ${platform}`,
    );
  }
  return r;
}

export function getTokenProvider(
  registry: OAuthRegistry,
  platform: Platform,
): TokenProvider {
  const p = registry.providers[platform];
  if (!p) {
    throw new Error(
      `oauth_token_provider_not_registered_for_platform: ${platform}`,
    );
  }
  return p;
}
