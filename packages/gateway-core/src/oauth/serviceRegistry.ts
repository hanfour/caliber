import type { OAuthService } from "./types.js";
import { createOpenAIOAuthService } from "./openai/openaiOAuthService.js";
import { createAnthropicOAuthService } from "./anthropic/anthropicOAuthService.js";
import {
  resolveAnthropicConstants,
  type AnthropicOAuthEnv,
} from "./anthropic/anthropicConstants.js";

export type SelfServicePlatform = "openai" | "anthropic";

export interface OAuthServiceEnv extends AnthropicOAuthEnv {
  ENABLE_ANTHROPIC_OAUTH: boolean;
}

// Thrown when a platform's self-service OAuth isn't available (anthropic
// behind ENABLE_ANTHROPIC_OAUTH). The api layer maps this to NOT_FOUND.
export class OAuthServiceUnavailableError extends Error {
  constructor(public readonly platform: string) {
    super(`oauth_self_service_unavailable: ${platform}`);
    this.name = "OAuthServiceUnavailableError";
  }
}

export interface ResolveOAuthServiceDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function resolveOAuthService(
  platform: SelfServicePlatform,
  env: OAuthServiceEnv,
  deps: ResolveOAuthServiceDeps = {},
): OAuthService {
  if (platform === "openai") {
    return createOpenAIOAuthService({ fetch: deps.fetch, now: deps.now });
  }
  if (platform === "anthropic") {
    if (!env.ENABLE_ANTHROPIC_OAUTH) {
      throw new OAuthServiceUnavailableError("anthropic");
    }
    return createAnthropicOAuthService({
      constants: resolveAnthropicConstants(env),
      fetch: deps.fetch,
      now: deps.now,
    });
  }
  throw new OAuthServiceUnavailableError(platform);
}
