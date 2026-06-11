import { describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "../../src/runtime/resolveCredential.js";
import type { Database } from "@caliber/db";
import type { BucketKey } from "@caliber/gateway-core/models";
import {
  authHeadersFor,
  baseUrlFor,
  buildRefreshDeps,
} from "../../src/models/registryWiring.js";

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

// ── Finding 3: registry refresh must not poison a bucket with a wrong-class
//    credential. `pickAccountId` selects by ROW type; if the decrypted
//    credential disagrees (stale `upstream_accounts.type`), the fetch must be
//    skipped (no upstream call with mismatched creds) and the bucket degrade to
//    its static fallback. ───────────────────────────────────────────────────

const oauthBucket: BucketKey = {
  platform: "openai",
  baseUrl: "https://sub2api.example",
  credentialType: "oauth",
};

/** A `db` stub whose `pickAccountId` query returns one active row id. */
function dbReturningAccountId(accountId: string | null): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(accountId ? [{ id: accountId }] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("buildRefreshDeps.fetchForBucket — credential-type guard (Finding 3)", () => {
  it("skips fetch + emits 'error' when decrypted credential class ≠ bucket type", async () => {
    const fetchMetric = vi.fn();
    const fetchSpy = vi.fn();
    // Row says oauth (so pickAccountId picked it for the oauth bucket), but the
    // decrypted credential is actually an api_key → mismatch.
    const mismatchedCred: ResolvedCredential = {
      type: "api_key",
      apiKey: "sk-stale-row",
    };
    const deps = buildRefreshDeps({
      db: dbReturningAccountId("acct-1"),
      env: {
        UPSTREAM_OPENAI_BASE_URL: "https://sub2api.example",
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(64),
      },
      fetchMetric,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      resolveCredentialImpl: () => Promise.resolve(mismatchedCred),
    });

    const result = await deps.fetchForBucket(oauthBucket);

    // Degrades to [] so the bucket keeps its static fallback.
    expect(result).toEqual([]);
    // Emits the fetch metric as "error" (clear signal of a stale row).
    expect(fetchMetric).toHaveBeenCalledWith("openai", "oauth", "error");
    // Crucially: the upstream /v1/models fetch was NEVER called with the
    // wrong-class credential.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 'error' + [] when no active account exists for the bucket", async () => {
    const fetchMetric = vi.fn();
    const fetchSpy = vi.fn();
    const deps = buildRefreshDeps({
      db: dbReturningAccountId(null),
      env: {
        UPSTREAM_OPENAI_BASE_URL: "https://sub2api.example",
        CREDENTIAL_ENCRYPTION_KEY: "k".repeat(64),
      },
      fetchMetric,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      resolveCredentialImpl: () =>
        Promise.reject(new Error("should not resolve when no account")),
    });

    const result = await deps.fetchForBucket(oauthBucket);

    expect(result).toEqual([]);
    expect(fetchMetric).toHaveBeenCalledWith("openai", "oauth", "error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
