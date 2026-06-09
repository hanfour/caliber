import { describe, it, expect } from "vitest";
import { createOpenAITokenRefresher } from "../../../src/oauth/openai/openaiTokenRefresher.js";
import { OPENAI_CODEX_OAUTH } from "@caliber/gateway-core/oauth";
import {
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
} from "../../../src/oauth/types.js";

function makeFakeFetch(
  responses: Array<{ status: number; body: string | object }>,
) {
  let callIdx = 0;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const r = responses[callIdx++];
    if (!r) throw new Error("fakeFetch: no response queued");
    const bodyStr =
      typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(bodyStr, {
      status: r.status,
      headers: { "content-type": "application/json" },
    }) as Response;
  };
  return { fakeFetch, calls };
}

describe("openaiTokenRefresher.refresh", () => {
  it("happy path: returns rotated refresh_token + new access_token", async () => {
    const fixedNow = 1_700_000_000_000;
    const { fakeFetch, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          access_token: "atk_v2",
          refresh_token: "rtk_v2_rotated",
          expires_in: 3600,
          token_type: "Bearer",
        },
      },
    ]);
    const refresher = createOpenAITokenRefresher({
      fetch: fakeFetch,
      now: () => fixedNow,
    });

    const result = await refresher.refresh("rtk_v1");
    expect(result.accessToken).toBe("atk_v2");
    expect(result.refreshToken).toBe("rtk_v2_rotated"); // rotation honoured
    expect(result.expiresAt.getTime()).toBe(fixedNow + 3600 * 1000);

    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(OPENAI_CODEX_OAUTH.tokenEndpoint);
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(OPENAI_CODEX_OAUTH.clientId);
    expect(body.get("refresh_token")).toBe("rtk_v1");
    expect(body.get("scope")).toBe(OPENAI_CODEX_OAUTH.refreshScopes);
  });

  it("throws when refresh response omits refresh_token (strict OpenAI contract)", async () => {
    // OpenAI's refresh-grant response always echoes refresh_token (the
    // existing one or a rotated one).  parseTokenResponse enforces this
    // — there is no "keep the old one" branch in the refresher because
    // the upstream contract guarantees the response carries one.  This
    // test pins that strict contract so future relaxations are explicit.
    const { fakeFetch } = makeFakeFetch([
      {
        status: 200,
        body: {
          access_token: "atk_v2",
          // refresh_token omitted intentionally
          expires_in: 3600,
        },
      },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });

    await expect(refresher.refresh("rtk_v1")).rejects.toThrow(
      /openai_oauth_token_response_missing_refresh_token/,
    );
  });

  it("HTTP 400 with invalid_grant in the body throws OAuthRefreshTokenInvalid", async () => {
    const { fakeFetch } = makeFakeFetch([
      {
        status: 400,
        body: '{"error":"invalid_grant","error_description":"Refresh token expired"}',
      },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });

    await expect(refresher.refresh("rtk_dead")).rejects.toBeInstanceOf(
      OAuthRefreshTokenInvalid,
    );
  });

  it("HTTP 401 with invalid_grant in body also throws OAuthRefreshTokenInvalid", async () => {
    const { fakeFetch } = makeFakeFetch([
      {
        status: 401,
        body: "auth failed: invalid_grant detected",
      },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });
    await expect(refresher.refresh("rtk_dead")).rejects.toBeInstanceOf(
      OAuthRefreshTokenInvalid,
    );
  });

  it("HTTP 5xx (transient) throws OAuthRefreshError but NOT OAuthRefreshTokenInvalid", async () => {
    const { fakeFetch } = makeFakeFetch([
      { status: 503, body: "upstream temporarily unavailable" },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });

    let thrown: unknown;
    try {
      await refresher.refresh("rtk_v1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OAuthRefreshError);
    expect(thrown).not.toBeInstanceOf(OAuthRefreshTokenInvalid);
  });

  it("HTTP 400 WITHOUT invalid_grant marker is treated as transient (OAuthRefreshError)", async () => {
    const { fakeFetch } = makeFakeFetch([
      {
        status: 400,
        body: '{"error":"server_error","error_description":"transient"}',
      },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });

    let thrown: unknown;
    try {
      await refresher.refresh("rtk_v1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OAuthRefreshError);
    expect(thrown).not.toBeInstanceOf(OAuthRefreshTokenInvalid);
  });

  it("network failure throws OAuthRefreshError tagged with `_network` (not bubbled raw)", async () => {
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    const refresher = createOpenAITokenRefresher({ fetch: failingFetch });
    await expect(refresher.refresh("rtk_v1")).rejects.toThrow(
      /openai_oauth_refresh_network/,
    );
  });

  it("AbortError (fetch timeout) throws OAuthRefreshError tagged with `_timeout`", async () => {
    const timeoutFetch: typeof globalThis.fetch = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    const refresher = createOpenAITokenRefresher({ fetch: timeoutFetch });
    await expect(refresher.refresh("rtk_v1")).rejects.toThrow(
      /openai_oauth_refresh_timeout/,
    );
  });

  it("non-JSON 200 body throws structured OAuthRefreshError, not raw SyntaxError", async () => {
    const { fakeFetch } = makeFakeFetch([
      { status: 200, body: "<html>maintenance</html>" },
    ]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });
    await expect(refresher.refresh("rtk_v1")).rejects.toThrow(
      /openai_oauth_refresh_response_not_json/,
    );
  });

  it("invalid_grant error message does NOT include the upstream body", async () => {
    const sensitive = "invalid_grant: refresh_token=ZNoNoSenSecret123 EXPIRED";
    const { fakeFetch } = makeFakeFetch([{ status: 400, body: sensitive }]);
    const refresher = createOpenAITokenRefresher({ fetch: fakeFetch });

    let thrown: Error | undefined;
    try {
      await refresher.refresh("rtk_v1");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(OAuthRefreshTokenInvalid);
    expect(thrown!.message).toBe("openai_oauth_invalid_grant");
    expect(thrown!.message).not.toContain("ZNoNoSenSecret123");
  });
});
