import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wiring test for the assembled `caliber login` flow. The original PR was
// green in CI while 404'ing live because each seam (device-auth, download,
// enroll args) was unit-tested in isolation and nothing asserted the values
// that actually flow BETWEEN them. This test stubs only the true process
// boundaries — fetch and spawnSync — and asserts the exact URLs and argv
// each one receives, as literals (not recomputed via the same helpers).
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

import { spawnSync } from "node:child_process";
import { loginCommand } from "../src/login/commands.js";

const SERVER = "https://caliber.example";
const TAR_BYTES = "fake-agent-tarball";
const TAR_SHA = createHash("sha256").update(TAR_BYTES).digest("hex");

function stubLoginFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith("/v1/device-auth/start")) {
      return new Response(
        JSON.stringify({
          device_code: "dc-e2e",
          user_code: "BCDF-GHJK",
          verification_uri: `${SERVER}/device`,
          verification_uri_complete: `${SERVER}/device?code=BCDF-GHJK`,
          interval: 0,
          expires_in: 900,
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/v1/device-auth/poll")) {
      return new Response(JSON.stringify({ enrollment_token: "tok-e2e" }), { status: 200 });
    }
    if (url.endsWith(".tar.gz.sha256")) {
      return new Response(`${TAR_SHA}  asset.tar.gz\n`);
    }
    if (url.endsWith(".tar.gz")) {
      return new Response(TAR_BYTES);
    }
    throw new Error(`unexpected fetch URL in login flow: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("loginCommand end-to-end wiring", () => {
  const origHome = process.env.HOME;
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "caliber-login-e2e-"));
    process.env.HOME = home;
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.HOME = origHome;
    Object.defineProperty(process, "platform", origPlatform);
    Object.defineProperty(process, "arch", origArch);
    rmSync(home, { recursive: true, force: true });
  });

  it("drives device-auth → download → enroll → service install with the exact cross-boundary values", async () => {
    const fetchMock = stubLoginFetch();

    await loginCommand({ server: `${SERVER}/` });

    // 1. Device-auth hits the /api-rewritten base, NOT the bare web origin (C2).
    const fetchedUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(fetchedUrls[0]).toBe("https://caliber.example/api/v1/device-auth/start");
    expect(fetchedUrls[1]).toBe("https://caliber.example/api/v1/device-auth/poll");

    // 2. Binary download: GitHub release URL + sha256 sidecar, exact literals.
    expect(fetchedUrls[2]).toBe(
      "https://github.com/hanfour/caliber/releases/download/agent/v0.2.0/caliber-agent-agent_v0.2.0-darwin-arm64.tar.gz",
    );
    expect(fetchedUrls[3]).toBe(`${fetchedUrls[2]}.sha256`);

    // 3. spawnSync boundary: browser open, tar extract, chmod, enroll, service.
    const spawnCalls = vi.mocked(spawnSync).mock.calls;
    const binPath = join(home, ".caliber", "bin", "caliber-agent");
    expect(spawnCalls[0]![0]).toBe("open");
    expect(spawnCalls[0]![1]).toEqual([`${SERVER}/device?code=BCDF-GHJK`]);
    expect(spawnCalls[1]![0]).toBe("tar");
    expect(spawnCalls[2]![0]).toBe("chmod");

    // The enroll argv is the TS↔Go contract: flags first, `--`, token last.
    expect(spawnCalls[3]![0]).toBe(binPath);
    expect(spawnCalls[3]![1]).toEqual([
      "enroll",
      "--api-base-url",
      "https://caliber.example/api",
      "--yes",
      "--watch-all",
      "--mode",
      "full-body",
      "--force",
      "--",
      "tok-e2e",
    ]);
    expect(spawnCalls[4]![0]).toBe(binPath);
    expect(spawnCalls[4]![1]).toEqual(["install-service"]);

    // 4. Persisted CLI state records the WEB origin (for dashboard links).
    const state = JSON.parse(readFileSync(join(home, ".caliber", "cli.json"), "utf-8"));
    expect(state).toEqual({
      serverUrl: "https://caliber.example",
      agentVersion: "agent/v0.2.0",
      binaryPath: binPath,
    });
  });

  it("aborts before enrolling when the downloaded tarball fails sha256 verification", async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/device-auth/start")) {
        return new Response(
          JSON.stringify({
            device_code: "dc-e2e",
            user_code: "BCDF-GHJK",
            verification_uri: `${SERVER}/device`,
            verification_uri_complete: `${SERVER}/device?code=BCDF-GHJK`,
            interval: 0,
            expires_in: 900,
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/device-auth/poll")) {
        return new Response(JSON.stringify({ enrollment_token: "tok-e2e" }), { status: 200 });
      }
      if (url.endsWith(".tar.gz.sha256")) {
        return new Response(`${"0".repeat(64)}  asset.tar.gz\n`);
      }
      if (url.endsWith(".tar.gz")) {
        return new Response(TAR_BYTES);
      }
      throw new Error(`unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", mock);

    await expect(loginCommand({ server: SERVER })).rejects.toThrow(/sha256 mismatch/);

    // Only the browser-open spawn happened — no tar/chmod/enroll/service on
    // an unverified artifact.
    const spawned = vi.mocked(spawnSync).mock.calls.map((c) => c[0]);
    expect(spawned).toEqual(["open"]);
  });
});
