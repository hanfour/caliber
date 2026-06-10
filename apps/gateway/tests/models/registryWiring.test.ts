import { describe, expect, it } from "vitest";
import type { ResolvedCredential } from "../../src/runtime/resolveCredential.js";
import { authHeadersFor, baseUrlFor } from "../../src/models/registryWiring.js";

const apiKeyCred: ResolvedCredential = { type: "api_key", apiKey: "sk-test-123" };
const oauthCred: ResolvedCredential = {
  type: "oauth",
  accessToken: "at-test-456",
  refreshToken: "rt-test",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

describe("authHeadersFor", () => {
  it("anthropic + oauth → Bearer + version + oauth beta", () => {
    expect(authHeadersFor("anthropic", oauthCred)).toEqual({
      authorization: "Bearer at-test-456",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    });
  });

  it("anthropic + api_key → x-api-key + version (no oauth beta)", () => {
    expect(authHeadersFor("anthropic", apiKeyCred)).toEqual({
      "x-api-key": "sk-test-123",
      "anthropic-version": "2023-06-01",
    });
  });

  it("openai + api_key → Bearer apiKey only", () => {
    expect(authHeadersFor("openai", apiKeyCred)).toEqual({
      authorization: "Bearer sk-test-123",
    });
  });

  it("openai + oauth → Bearer accessToken only", () => {
    expect(authHeadersFor("openai", oauthCred)).toEqual({
      authorization: "Bearer at-test-456",
    });
  });
});

describe("baseUrlFor", () => {
  it("anthropic defaults to api.anthropic.com when env unset", () => {
    expect(baseUrlFor("anthropic", {})).toBe("https://api.anthropic.com");
  });

  it("anthropic honours UPSTREAM_ANTHROPIC_BASE_URL override", () => {
    expect(
      baseUrlFor("anthropic", { UPSTREAM_ANTHROPIC_BASE_URL: "https://proxy.example" }),
    ).toBe("https://proxy.example");
  });

  it("openai comes from UPSTREAM_OPENAI_BASE_URL", () => {
    expect(
      baseUrlFor("openai", { UPSTREAM_OPENAI_BASE_URL: "https://sub2api.example" }),
    ).toBe("https://sub2api.example");
  });

  it("openai with no base url configured → empty string", () => {
    expect(baseUrlFor("openai", {})).toBe("");
  });
});
