import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let orig: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caliber-cli-"));
  orig = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  process.env.HOME = orig;
  rmSync(tmp, { recursive: true, force: true });
});

describe("cli state", () => {
  it("returns null when unset", async () => {
    const { loadCliState } = await import("../src/login/state.js");
    expect(loadCliState()).toBeNull();
  });
  it("round-trips save/load and clears", async () => {
    const { loadCliState, saveCliState, clearCliState } = await import("../src/login/state.js");
    saveCliState({ serverUrl: "https://caliber.miilink.net", agentVersion: "agent/v0.2.0", binaryPath: join(tmp, ".caliber/bin/caliber-agent") });
    expect(loadCliState()?.serverUrl).toBe("https://caliber.miilink.net");
    clearCliState();
    expect(loadCliState()).toBeNull();
  });
});
