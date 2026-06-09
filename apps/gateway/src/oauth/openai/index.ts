// Plan 5A — registry-bootstrap helper that composes the 4 OpenAI pieces
// in one place.  Server boot calls `registerOpenAIOAuth(registry, {...})`
// when `ENABLE_OPENAI_PROVIDER=true`; otherwise no OpenAI handlers are
// registered and any caller that asks for an OpenAI service /
// refresher / provider gets the registry's "not registered" error.
//
// PR 5 ships the wiring; PR 5b will pass this helper into the gateway
// boot path so the 4-piece set is ready before the new /v1/responses
// route comes online in PR 9.

import type { OAuthRegistry } from "../registry.js";
import type { RefreshApiLike } from "../types.js";
import { createOpenAIOAuthService } from "@caliber/gateway-core/oauth";
import { createOpenAITokenProvider } from "./openaiTokenProvider.js";
import { createOpenAITokenRefresher } from "./openaiTokenRefresher.js";

export interface RegisterOpenAIOAuthDeps {
  refreshApi: RefreshApiLike;
  /** Test hook for fetch / clock injection across all 3 pieces. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Register the OpenAI 4-piece into an empty `OAuthRegistry`.  Returns
 * the same registry mutated in-place + the constructed pieces (for
 * direct DI in tests / other callers that want to skip the registry).
 */
export function registerOpenAIOAuth(
  registry: OAuthRegistry,
  deps: RegisterOpenAIOAuthDeps,
): OAuthRegistry {
  const service = createOpenAIOAuthService({
    fetch: deps.fetch,
    now: deps.now,
  });
  const refresher = createOpenAITokenRefresher({
    fetch: deps.fetch,
    now: deps.now,
  });
  const provider = createOpenAITokenProvider({
    refreshApi: deps.refreshApi,
  });

  registry.services.openai = service;
  registry.refreshers.openai = refresher;
  registry.providers.openai = provider;

  return registry;
}

export {
  createOpenAITokenProvider,
  createOpenAITokenRefresher,
};
export { createOpenAIOAuthService } from "@caliber/gateway-core/oauth";
export {
  OPENAI_CODEX_OAUTH,
  OPENAI_API_BASE,
  CHATGPT_BACKEND_API,
} from "@caliber/gateway-core/oauth";
