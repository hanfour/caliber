import { describe, it, expect } from "vitest";
import { createAnthropicOAuthService } from "../../../src/oauth/anthropic/anthropicOAuthService.js";
import { ANTHROPIC_OAUTH_DEFAULTS } from "../../../src/oauth/anthropic/anthropicConstants.js";

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("anthropicOAuthService", () => {
  it("generateAuthURL builds claude.ai authorize URL with PKCE S256 + redirectURI", async () => {
    const svc = createAnthropicOAuthService({
      constants: ANTHROPIC_OAUTH_DEFAULTS,
      fetch: fakeFetch([]).fn,
    });
    const auth = await svc.generateAuthURL({});
    const u = new URL(auth.authUrl);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe(
      ANTHROPIC_OAUTH_DEFAULTS.clientId,
    );
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe(
      "user:profile user:inference user:sessions:claude_code",
    );
    expect(u.searchParams.get("state")).toBe(auth.state);
    expect(auth.redirectURI).toBe(ANTHROPIC_OAUTH_DEFAULTS.defaultRedirectURI);
  });

  it("exchangeCode POSTs JSON authorization_code and returns a TokenSet", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { access_token: "atk", refresh_token: "rtk", expires_in: 3600 } },
    ]);
    const svc = createAnthropicOAuthService({ constants: ANTHROPIC_OAUTH_DEFAULTS, fetch: fn, now: () => 1000 });
    const ts = await svc.exchangeCode({ code: "c", codeVerifier: "v", redirectURI: "https://x/cb" });
    expect(ts.accessToken).toBe("atk");
    expect(ts.refreshToken).toBe("rtk");
    expect(ts.expiresAt).toEqual(new Date(1000 + 3600 * 1000));
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "https://x/cb", client_id: ANTHROPIC_OAUTH_DEFAULTS.clientId });
  });

  it("exchangeCode throws on non-2xx", async () => {
    const svc = createAnthropicOAuthService({ constants: ANTHROPIC_OAUTH_DEFAULTS, fetch: fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]).fn });
    await expect(svc.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow(/anthropic_oauth_exchange_failed/);
  });
});
