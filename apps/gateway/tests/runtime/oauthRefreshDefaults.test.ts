import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_TOKEN_URL,
} from "../../src/runtime/oauthRefresh.js";

// Regression guard for issue #86 — anthropic returned 404 not_found_error
// for ~weeks because the refresh endpoint was hardcoded to a path that
// no longer exists. Don't let the URL silently revert.
describe("oauthRefresh defaults", () => {
  it("DEFAULT_TOKEN_URL points at the v1/oauth/token path on console.anthropic.com", () => {
    expect(DEFAULT_TOKEN_URL).toBe(
      "https://console.anthropic.com/v1/oauth/token",
    );
    expect(DEFAULT_TOKEN_URL).toMatch(/\/v1\/oauth\/token$/);
    // Anthropic moved this off api.anthropic.com — guard against it
    // reappearing.
    expect(DEFAULT_TOKEN_URL).not.toMatch(/api\.anthropic\.com/);
  });

  it("DEFAULT_CLIENT_ID matches the public Claude Max client_id", () => {
    expect(DEFAULT_CLIENT_ID).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});
