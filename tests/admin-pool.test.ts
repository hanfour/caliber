import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const question = vi.fn(async () =>
  "http://localhost:54545/callback?code=grant&state=state-1",
);
const close = vi.fn();
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({ question, close })),
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

import { spawnSync } from "node:child_process";
import { addClaudeSubscriptionToPool } from "../src/admin-pool.js";
import { saveCliState } from "../src/login/state.js";

describe("admin pool CLI OAuth flow", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "caliber-admin-pool-"));
    process.env.HOME = home;
    question.mockClear();
    close.mockClear();
    vi.mocked(spawnSync).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("starts OAuth, opens the browser, and completes the same flow", async () => {
    saveCliState({
      serverUrl: "https://caliber.example",
      agentVersion: "agent/test",
      binaryPath: join(home, ".caliber/bin/caliber-agent"),
      accessToken: "cct_admin",
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/start")) {
        return new Response(
          JSON.stringify({
            flow_id: "state-1",
            auth_url: "https://claude.ai/oauth/authorize?state=state-1",
            expires_in: 600,
            org: { id: "org-1", slug: "onead", name: "OneAD" },
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/oauth/complete")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          flow_id: "state-1",
          pasted_value:
            "http://localhost:54545/callback?code=grant&state=state-1",
        });
        return new Response(
          JSON.stringify({
            id: "account-1",
            name: "Claude Max shared",
            platform: "anthropic",
            type: "oauth",
            scope: "organization",
            status: "active",
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const account = await addClaudeSubscriptionToPool({
      org: "onead",
      name: "Claude Max shared",
    });

    expect(account.id).toBe("account-1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://caliber.example/api/v1/cli/admin/pool/oauth/start",
    );
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: "Bearer cct_admin",
    });
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      expect.any(String),
      ["https://claude.ai/oauth/authorize?state=state-1"],
      { stdio: "ignore" },
    );
    expect(question).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
