import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, chmodSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let tmp: string;
let origHome: string | undefined;
let origExitCode: number | string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caliber-logout-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  origExitCode = process.exitCode;
  process.exitCode = undefined;
  delete process.env.FAKE_UNINSTALL_EXIT;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.exitCode = origExitCode;
  delete process.env.FAKE_UNINSTALL_EXIT;
  rmSync(tmp, { recursive: true, force: true });
});

// A stand-in for the Go agent binary: `uninstall` must have been called with
// `--yes` as its very next argv entry, or it fails (exit 9) — this catches a
// regression back to the H2 bug (uninstall invoked without --yes, which
// would prompt "Continue? [y/N]" and hang/decline on a non-TTY). Its actual
// exit code for a well-formed `uninstall --yes` call is controlled by
// $FAKE_UNINSTALL_EXIT (default 0 = success), inherited from the parent env
// since logoutCommand's spawnSync calls pass no explicit `env` override.
// `uninstall-service` (darwin only, no flags) always exits 0.
function writeFakeAgent(binPath: string): void {
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "uninstall" ]; then',
      '  if [ "$2" != "--yes" ]; then exit 9; fi',
      '  exit "${FAKE_UNINSTALL_EXIT:-0}"',
      "fi",
      'if [ "$1" = "uninstall-service" ]; then exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(binPath, 0o755);
}

describe("logoutCommand (H2)", () => {
  it("passes --yes to uninstall, clears state, and removes ~/.caliber/bin on success", async () => {
    const { logoutCommand } = await import("../src/login/commands.js");
    const { saveCliState, loadCliState, agentBinaryPath, cliStateDir } = await import("../src/login/state.js");
    const binPath = agentBinaryPath();
    writeFakeAgent(binPath);
    saveCliState({ serverUrl: "https://x", agentVersion: "agent/v0.2.0", binaryPath: binPath });

    logoutCommand();

    // Fails closed (exit 9 → exitCode 1) if --yes were ever dropped.
    expect(process.exitCode).toBeUndefined();
    expect(loadCliState()).toBeNull();
    expect(existsSync(join(cliStateDir(), "bin"))).toBe(false);
  });

  it("does NOT clear local state and sets exitCode=1 when the agent's uninstall (revoke) fails", async () => {
    process.env.FAKE_UNINSTALL_EXIT = "130"; // e.g. declined on a non-TTY
    const { logoutCommand } = await import("../src/login/commands.js");
    const { saveCliState, loadCliState, agentBinaryPath, cliStateDir } = await import("../src/login/state.js");
    const binPath = agentBinaryPath();
    writeFakeAgent(binPath);
    saveCliState({ serverUrl: "https://x", agentVersion: "agent/v0.2.0", binaryPath: binPath });

    logoutCommand();

    expect(process.exitCode).toBe(1);
    // Local state must survive so the device isn't silently orphaned:
    // cli.json still points at the (still-enrolled) device/binary.
    expect(loadCliState()).not.toBeNull();
    expect(existsSync(join(cliStateDir(), "bin"))).toBe(true);
  });

  it("succeeds (clears state) when there is no agent binary to revoke", async () => {
    const { logoutCommand } = await import("../src/login/commands.js");
    const { saveCliState, loadCliState, agentBinaryPath } = await import("../src/login/state.js");
    // Deliberately do NOT write a binary at agentBinaryPath().
    saveCliState({ serverUrl: "https://x", agentVersion: "agent/v0.2.0", binaryPath: agentBinaryPath() });

    logoutCommand();

    expect(process.exitCode).toBeUndefined();
    expect(loadCliState()).toBeNull();
  });
});
