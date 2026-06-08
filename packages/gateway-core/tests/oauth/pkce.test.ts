import { describe, it, expect } from "vitest";
import {
  generatePKCEVerifier,
  generateCodeChallenge,
  generateState,
  sha256Base64Url,
} from "../../src/oauth/pkce.js";

describe("pkce", () => {
  it("verifier is 43-char base64url (32 bytes)", () => {
    expect(generatePKCEVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("challenge matches the RFC 7636 appendix B S256 known-answer vector", () => {
    // Independent oracle: RFC 7636 §appendix B test pair.
    expect(
      generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(generateCodeChallenge("test-verifier")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });
  it("state is 22-char base64url (16 bytes)", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
