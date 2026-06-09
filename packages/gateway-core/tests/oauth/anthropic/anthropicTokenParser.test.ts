import { describe, it, expect } from "vitest";
import { parseAnthropicTokenResponse } from "../../../src/oauth/anthropic/anthropicTokenParser.js";

describe("parseAnthropicTokenResponse", () => {
  it("returns a TokenSet for a well-formed response", () => {
    const ts = parseAnthropicTokenResponse(
      { access_token: "atk", refresh_token: "rtk", expires_in: 3600 },
      () => 1000,
    );
    expect(ts.accessToken).toBe("atk");
    expect(ts.refreshToken).toBe("rtk");
    expect(ts.expiresAt).toEqual(new Date(1000 + 3600 * 1000));
    expect(ts.tokenType).toBe("Bearer");
  });

  it("throws (anthropic-coded) on missing access_token", () => {
    expect(() =>
      parseAnthropicTokenResponse({ refresh_token: "rtk", expires_in: 3600 }, () => 0),
    ).toThrow(/anthropic_oauth_token_response_missing_access_token/);
  });

  it("throws (anthropic-coded) on missing refresh_token", () => {
    expect(() =>
      parseAnthropicTokenResponse({ access_token: "atk", expires_in: 3600 }, () => 0),
    ).toThrow(/anthropic_oauth_token_response_missing_refresh_token/);
  });

  it("throws (anthropic-coded) on invalid expires_in", () => {
    expect(() =>
      parseAnthropicTokenResponse({ access_token: "atk", refresh_token: "rtk", expires_in: 0 }, () => 0),
    ).toThrow(/anthropic_oauth_token_response_invalid_expires_in/);
  });
});
