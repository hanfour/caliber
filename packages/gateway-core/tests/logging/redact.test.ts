import { describe, it, expect } from "vitest";
import {
  LOG_REDACT_PATHS,
  maskCredentialMaterial,
  safeErrorMessage,
} from "../../src/logging/redact.js";

describe("maskCredentialMaterial", () => {
  it("redacts an Anthropic sk-ant- key", () => {
    const out = maskCredentialMaterial(
      "Refresh failed for sk-ant-api03-xy_zABC1234567890def at endpoint",
    );
    expect(out).toBe(
      "Refresh failed for [REDACTED-ANTHROPIC-KEY] at endpoint",
    );
  });

  it("redacts an OpenAI project key", () => {
    const out = maskCredentialMaterial(
      "401 from upstream: invalid sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123",
    );
    expect(out).toBe(
      "401 from upstream: invalid [REDACTED-OPENAI-KEY]",
    );
  });

  it("redacts an OpenAI service account key", () => {
    const out = maskCredentialMaterial(
      "key=sk-svcacct-1234567890abcdef1234567890abcdef rejected",
    );
    expect(out).toBe("key=[REDACTED-OPENAI-KEY] rejected");
  });

  it("redacts a generic OpenAI sk- key (less specific prefix)", () => {
    const out = maskCredentialMaterial(
      "got token sk-A1B2C3D4E5F6G7H8I9J0K1L2M3 in error body",
    );
    expect(out).toBe("got token [REDACTED-OPENAI-KEY] in error body");
  });

  it("redacts a gateway-issued ak_ key", () => {
    const raw =
      "key invalid: ak_" + "a".repeat(56) + " at /v1/messages";
    const out = maskCredentialMaterial(raw);
    expect(out).toBe("key invalid: [REDACTED-GATEWAY-KEY] at /v1/messages");
  });

  it("redacts Authorization Bearer header copy in error body", () => {
    const out = maskCredentialMaterial(
      'request had header "Authorization: Bearer abcdef1234567890.signature"',
    );
    expect(out).toBe(
      'request had header "Authorization: Bearer [REDACTED-BEARER]"',
    );
  });

  it("redacts a JWT-ish access token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = maskCredentialMaterial(`refresh body: ${jwt} 401`);
    expect(out).toBe("refresh body: [REDACTED-JWT] 401");
  });

  it("redacts multiple distinct credential shapes in one string", () => {
    const out = maskCredentialMaterial(
      "primary sk-proj-AaaaaaaaaaaaaaaaaaaaB and fallback sk-ant-api03-XxxxxxxxxxxxxxxxxxxxY",
    );
    expect(out).toBe(
      "primary [REDACTED-OPENAI-KEY] and fallback [REDACTED-ANTHROPIC-KEY]",
    );
  });

  it("is idempotent — running twice doesn't double-redact placeholders", () => {
    const once = maskCredentialMaterial(
      "saw sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123",
    );
    const twice = maskCredentialMaterial(once);
    expect(twice).toBe(once);
  });

  it("leaves credential-free strings untouched", () => {
    const text = "DB connection refused at host:port; retrying in 5s";
    expect(maskCredentialMaterial(text)).toBe(text);
  });

  it("handles empty + falsy inputs without throwing", () => {
    expect(maskCredentialMaterial("")).toBe("");
  });

  it("does not over-match short tokens that share a prefix", () => {
    // `sk-ant-x` is shorter than the {20,} threshold — the regex shouldn't
    // touch it. Important because user-typed prose like
    // "use the sk-ant prefix" should be readable in logs.
    expect(maskCredentialMaterial("the sk-ant prefix means anthropic")).toBe(
      "the sk-ant prefix means anthropic",
    );
  });

  it("masks fine-grained GitHub PATs", () => {
    const input =
      "boom github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP failed";
    const out = maskCredentialMaterial(input);
    expect(out).not.toContain("github_pat_11ABCDEFG");
    expect(out).toContain("[REDACTED-GITHUB-PAT]");
  });

  it("masks classic ghp_/gho_ style GitHub tokens", () => {
    const out = maskCredentialMaterial(
      "auth ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 rejected",
    );
    expect(out).not.toContain("ghp_AbCdEfGh");
    expect(out).toContain("[REDACTED-GITHUB-TOKEN]");
  });
});

describe("safeErrorMessage", () => {
  it("extracts and masks Error.message", () => {
    const err = new Error(
      "upstream rejected sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123",
    );
    expect(safeErrorMessage(err)).toBe(
      "upstream rejected [REDACTED-OPENAI-KEY]",
    );
  });

  it("falls through to String(err) for non-Error values + masks", () => {
    expect(safeErrorMessage("rejected ak_" + "b".repeat(50))).toBe(
      "rejected [REDACTED-GATEWAY-KEY]",
    );
  });

  it("handles undefined / null gracefully", () => {
    expect(safeErrorMessage(undefined)).toBe("undefined");
    expect(safeErrorMessage(null)).toBe("null");
  });
});

describe("LOG_REDACT_PATHS", () => {
  it("exports a non-empty list of pino path strings", () => {
    expect(LOG_REDACT_PATHS.length).toBeGreaterThan(10);
    for (const p of LOG_REDACT_PATHS) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it("covers the canonical credential field names + auth headers", () => {
    // Spot-check the must-have entries — unit-test catches regressions if
    // someone removes one of the obvious paths in a refactor.
    expect(LOG_REDACT_PATHS).toContain("req.headers.authorization");
    expect(LOG_REDACT_PATHS).toContain("req.headers.cookie");
    expect(LOG_REDACT_PATHS).toContain("*.access_token");
    expect(LOG_REDACT_PATHS).toContain("*.refresh_token");
    expect(LOG_REDACT_PATHS).toContain("*.api_key");
    expect(LOG_REDACT_PATHS).toContain("*.password");
    expect(LOG_REDACT_PATHS).toContain("*.credentials");
    expect(LOG_REDACT_PATHS).toContain("*.masterKeyHex");
  });

  it("covers generic token-shaped keys carried through tRPC inputs", () => {
    // These were added after the 2026-05-20 audit so an invite-accept or
    // device-enroll failure whose input is logged via the tRPC onError path
    // never spills the bearer to api.log.
    expect(LOG_REDACT_PATHS).toContain("*.token");
    expect(LOG_REDACT_PATHS).toContain("*.revealToken");
    expect(LOG_REDACT_PATHS).toContain("*.inviteToken");
    expect(LOG_REDACT_PATHS).toContain("*.enrollmentToken");
    expect(LOG_REDACT_PATHS).toContain("*.bearer");
    expect(LOG_REDACT_PATHS).toContain("*.signingKey");
    expect(LOG_REDACT_PATHS).toContain("*.privateKey");
  });
});
