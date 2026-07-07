import { describe, it, expect, vi, afterEach } from "vitest";
import { startDeviceAuth, pollUntilApproved } from "../src/login/device-auth.js";

afterEach(() => vi.unstubAllGlobals());

type FetchStep =
  | { status: number; body: unknown }
  | { reject: Error }
  | { status: number; jsonError: Error };

function stubFetchSteps(steps: FetchStep[]) {
  let i = 0;
  const mock = vi.fn(async () => {
    const s = steps[Math.min(i++, steps.length - 1)];
    if ("reject" in s) throw s.reject;
    if ("jsonError" in s) {
      return {
        status: s.status,
        ok: s.status < 400,
        json: async () => {
          throw s.jsonError;
        },
      } as Response;
    }
    return { status: s.status, ok: s.status < 400, json: async () => s.body } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  return stubFetchSteps(responses);
}

describe("startDeviceAuth", () => {
  it("posts metadata and returns the flow", async () => {
    stubFetchSequence([{ status: 201, body: { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://x/device", verification_uri_complete: "https://x/device?code=BCDF-GHJK", interval: 5, expires_in: 900 } }]);
    const start = await startDeviceAuth("https://x", { hostname: "h", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" });
    expect(start.user_code).toBe("BCDF-GHJK");
  });

  it("passes an abort/timeout signal so a stalled connection cannot hang the CLI", async () => {
    const mock = stubFetchSteps([{ status: 201, body: { device_code: "dc", user_code: "U", verification_uri: "u", verification_uri_complete: "u", interval: 5, expires_in: 900 } }]);
    await startDeviceAuth("https://x", { hostname: "h", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("pollUntilApproved", () => {
  const start = { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "u", verification_uri_complete: "u", interval: 0, expires_in: 900 };
  it("resolves the enrollment token after pending rounds", async () => {
    stubFetchSequence([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { enrollment_token: "tok_xyz" } },
    ]);
    const token = await pollUntilApproved("https://x", start, { sleep: async () => {} });
    expect(token.enrollmentToken).toBe("tok_xyz");
  });
  it("returns the gateway api_key + url when --gateway provisioning was fulfilled (#256)", async () => {
    stubFetchSequence([
      { status: 200, body: { enrollment_token: "tok_gw", api_key: "ak_live", gateway_url: "https://gw.x" } },
    ]);
    const res = await pollUntilApproved("https://x", start, { sleep: async () => {} });
    expect(res.enrollmentToken).toBe("tok_gw");
    expect(res.apiKey).toBe("ak_live");
    expect(res.gatewayUrl).toBe("https://gw.x");
  });

  it("sends provision_gateway only when requested", async () => {
    const mock = stubFetchSteps([
      { status: 201, body: { device_code: "d", user_code: "U", verification_uri: "u", verification_uri_complete: "u", interval: 5, expires_in: 900 } },
    ]);
    await startDeviceAuth("https://x", { hostname: "h", os: "d", agentVersion: "0", cliVersion: "0" }, { provisionGateway: true });
    expect(JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string).provision_gateway).toBe(true);
    mock.mockClear();
    await startDeviceAuth("https://x", { hostname: "h", os: "d", agentVersion: "0", cliVersion: "0" });
    expect(JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string).provision_gateway).toBeUndefined();
  });

  it("throws on access_denied", async () => {
    stubFetchSequence([{ status: 400, body: { error: "access_denied" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/denied/i);
  });
  it("throws on expired_token", async () => {
    stubFetchSequence([{ status: 400, body: { error: "expired_token" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/expired/i);
  });
  // The poll window is up to 15 minutes; a single transient hiccup (proxy
  // 502 HTML page during a deploy, dropped connection) must NOT abort the
  // whole login — only terminal errors and the deadline may.
  it("retries after a transport-level fetch failure", async () => {
    stubFetchSteps([
      { reject: new TypeError("fetch failed") },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { enrollment_token: "tok_net" } },
    ]);
    const token = await pollUntilApproved("https://x", start, { sleep: async () => {} });
    expect(token.enrollmentToken).toBe("tok_net");
  });

  it("retries when the poll response body is not JSON (e.g. proxy 502 page)", async () => {
    stubFetchSteps([
      { status: 502, jsonError: new SyntaxError("Unexpected token '<'") },
      { status: 200, body: { enrollment_token: "tok_html" } },
    ]);
    const token = await pollUntilApproved("https://x", start, { sleep: async () => {} });
    expect(token.enrollmentToken).toBe("tok_html");
  });

  it("still enforces the deadline when every poll attempt fails", async () => {
    stubFetchSteps([{ reject: new TypeError("fetch failed") }]);
    const shortStart = { ...start, expires_in: 1 };
    let call = 0;
    const now = () => (call++ === 0 ? 0 : shortStart.expires_in * 1000 + 1);
    await expect(
      pollUntilApproved("https://x", shortStart, { sleep: async () => {}, now }),
    ).rejects.toThrow(/expired/i);
  });

  it("passes an abort/timeout signal to every poll request", async () => {
    const mock = stubFetchSteps([{ status: 200, body: { enrollment_token: "tok_sig" } }]);
    await pollUntilApproved("https://x", start, { sleep: async () => {} });
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws once the deadline is exceeded, even without an expired_token error", async () => {
    stubFetchSequence([{ status: 400, body: { error: "authorization_pending" } }]);
    const shortStart = { ...start, expires_in: 1 };
    // Fake clock: first call establishes the deadline, every call after
    // that reports a time already past it, forcing the deadline branch.
    let call = 0;
    const now = () => (call++ === 0 ? 0 : shortStart.expires_in * 1000 + 1);
    await expect(
      pollUntilApproved("https://x", shortStart, { sleep: async () => {}, now }),
    ).rejects.toThrow(/expired/i);
  });
});
