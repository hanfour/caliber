import { describe, it, expect } from "vitest";
import {
  resolveOAuthService,
  OAuthServiceUnavailableError,
} from "../../src/oauth/serviceRegistry.js";

describe("resolveOAuthService", () => {
  it("returns the openai service", () => {
    expect(resolveOAuthService("openai", { ENABLE_ANTHROPIC_OAUTH: false }).platform).toBe("openai");
  });
  it("returns the anthropic service when enabled", () => {
    expect(resolveOAuthService("anthropic", { ENABLE_ANTHROPIC_OAUTH: true }).platform).toBe("anthropic");
  });
  it("throws OAuthServiceUnavailableError for anthropic when flag off", () => {
    expect(() => resolveOAuthService("anthropic", { ENABLE_ANTHROPIC_OAUTH: false })).toThrow(OAuthServiceUnavailableError);
  });
});
