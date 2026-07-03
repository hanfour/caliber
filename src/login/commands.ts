import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { startDeviceAuth, pollUntilApproved } from "./device-auth.js";
import { assetName, assetUrl, downloadAndVerify, extractBinary, resolvePlatform } from "./download.js";
import { agentBinaryPath, cliStateDir, clearCliState, loadCliState, saveCliState } from "./state.js";
import { AGENT_REPO, AGENT_TAG, DEFAULT_SERVER_URL } from "./constants.js";

// Keep in sync with the `program.version(...)` declared in cli.ts.
const CLI_VERSION = "0.1.0";

const log = (msg: string) => process.stderr.write(msg + "\n");

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(cmd, [url], { stdio: "ignore" });
}

export interface LoginOptions {
  server?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const serverUrl = (opts.server ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  const { platform, arch } = resolvePlatform();

  // 1. Device-code authorization
  log(chalk.dim("Requesting device authorization…"));
  const start = await startDeviceAuth(serverUrl, {
    hostname: hostname(),
    os: `${platform}-${arch}`,
    agentVersion: AGENT_TAG,
    cliVersion: CLI_VERSION,
  });
  log("");
  log(`  ${chalk.bold("Open:")} ${start.verification_uri}`);
  log(`  ${chalk.bold("Code:")} ${chalk.cyan(start.user_code)}`);
  log("");
  openBrowser(start.verification_uri_complete);
  log(chalk.dim("Waiting for approval in the browser…"));
  const enrollmentToken = await pollUntilApproved(serverUrl, start);
  log(chalk.green("✓ Authorized"));

  // 2. Download the agent binary (skip if already the pinned version)
  const binPath = agentBinaryPath();
  const state = loadCliState();
  if (!(state?.agentVersion === AGENT_TAG && existsSync(binPath))) {
    const name = assetName(AGENT_TAG, platform, arch);
    const url = assetUrl(AGENT_REPO, AGENT_TAG, name);
    const tarPath = join(tmpdir(), name);
    log(chalk.dim(`Downloading ${name}…`));
    // downloadAndVerify is the supply-chain security gate: it downloads,
    // verifies sha256, and deletes+throws on mismatch. Never proceed to
    // enroll with an unverified binary.
    await downloadAndVerify(url, `${url}.sha256`, tarPath);
    await extractBinary(tarPath, join(cliStateDir(), "bin"));
    spawnSync("chmod", ["+x", binPath], { stdio: "ignore" });
    log(chalk.green("✓ Agent downloaded and verified"));
  }

  // 3. Non-interactive enroll (watch-all, full-body)
  const enroll = spawnSync(
    binPath,
    ["enroll", enrollmentToken, "--server", serverUrl, "--yes", "--watch-all", "--mode", "full-body"],
    { stdio: "inherit" },
  );
  if (enroll.status !== 0) throw new Error("Agent enrollment failed.");

  // 4. Install the resident service (macOS launchd; other platforms print guidance)
  if (platform === "darwin") {
    const svc = spawnSync(binPath, ["install-service"], { stdio: "inherit" });
    if (svc.status !== 0) throw new Error("Failed to install the launchd service.");
  } else {
    log(
      chalk.yellow(
        "Linux: resident mode not auto-installed. Run `caliber agent run` (or add a systemd user unit) to keep it running.",
      ),
    );
  }

  saveCliState({ serverUrl, agentVersion: AGENT_TAG, binaryPath: binPath });
  log("");
  log(chalk.green.bold("✓ caliber is now recording your Claude Code / Codex sessions."));
  log(chalk.dim(`  Backfilling the past 90 days. Dashboard: ${serverUrl}/dashboard/devices`));
  log(chalk.dim("  Pause anytime with `caliber agent pause`."));
}

export function logoutCommand(): void {
  const state = loadCliState();
  const binPath = state?.binaryPath ?? agentBinaryPath();
  if (existsSync(binPath)) {
    if (process.platform === "darwin") spawnSync(binPath, ["uninstall-service"], { stdio: "inherit" });
    spawnSync(binPath, ["uninstall"], { stdio: "inherit" });
  }
  clearCliState();
  process.stderr.write(chalk.green("✓ Logged out and stopped recording.\n"));
}

export function agentPassthrough(sub: "status" | "pause" | "resume"): void {
  const binPath = loadCliState()?.binaryPath ?? agentBinaryPath();
  if (!existsSync(binPath)) {
    process.stderr.write(chalk.red("Not logged in. Run `caliber login` first.\n"));
    process.exitCode = 1;
    return;
  }
  const r = spawnSync(binPath, [sub], { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
}
