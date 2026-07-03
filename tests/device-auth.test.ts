import { describe, it, expect, vi, afterEach } from "vitest";
import { startDeviceAuth, pollUntilApproved } from "../src/login/device-auth.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, ok: r.status < 400, json: async () => r.body } as Response;
  }));
}

describe("startDeviceAuth", () => {
  it("posts metadata and returns the flow", async () => {
    stubFetchSequence([{ status: 201, body: { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://x/device", verification_uri_complete: "https://x/device?code=BCDF-GHJK", interval: 5, expires_in: 900 } }]);
    const start = await startDeviceAuth("https://x", { hostname: "h", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" });
    expect(start.user_code).toBe("BCDF-GHJK");
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
    expect(token).toBe("tok_xyz");
  });
  it("throws on access_denied", async () => {
    stubFetchSequence([{ status: 400, body: { error: "access_denied" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/denied/i);
  });
  it("throws on expired_token", async () => {
    stubFetchSequence([{ status: 400, body: { error: "expired_token" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/expired/i);
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
