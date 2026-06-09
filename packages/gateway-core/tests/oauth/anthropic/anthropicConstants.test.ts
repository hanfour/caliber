import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_OAUTH_DEFAULTS,
  resolveAnthropicConstants,
} from "../../../src/oauth/anthropic/anthropicConstants.js";

describe("resolveAnthropicConstants", () => {
  it("uses best-known defaults when env empty", () => {
    const c = resolveAnthropicConstants({});
    expect(c.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(c.authorizeEndpoint).toBe("https://claude.ai/oauth/authorize");
    expect(c.tokenEndpoint).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(c.defaultRedirectURI).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    );
    expect(c.scopes).toEqual([
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
    ]);
  });
  it("env overrides authorize/redirect/scopes (scopes split on whitespace)", () => {
    const c = resolveAnthropicConstants({
      ANTHROPIC_OAUTH_AUTHORIZE_URL: "https://x.test/authorize",
      ANTHROPIC_OAUTH_REDIRECT_URI: "https://x.test/cb",
      ANTHROPIC_OAUTH_SCOPES: "a:b  c:d",
    });
    expect(c.authorizeEndpoint).toBe("https://x.test/authorize");
    expect(c.defaultRedirectURI).toBe("https://x.test/cb");
    expect(c.scopes).toEqual(["a:b", "c:d"]);
  });
});
