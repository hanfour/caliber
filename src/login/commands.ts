import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { startDeviceAuth, pollUntilApproved } from "./device-auth.js";
import { assetName, assetUrl, downloadAndVerify, extractBinary, resolvePlatform } from "./download.js";
import { agentBinaryPath, cliStateDir, clearCliState, loadCliState, saveCliState } from "./state.js";
import { AGENT_REPO, AGENT_TAG, DEFAULT_SERVER_URL } from "./constants.js";

// Keep in sync with the `program.version(...)` declared in cli.ts, and both
// with package.json's `version` field.
const CLI_VERSION = "0.2.0";

const log = (msg: string) => process.stderr.write(msg + "\n");

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(cmd, [url], { stdio: "ignore" });
}

export interface LoginOptions {
  server?: string;
}

// The `--server` value (and DEFAULT_SERVER_URL) is the Caliber WEB origin —
// it fronts the Next.js dashboard, which only exposes the api under the
// `/api/v1/:path*` rewrite (apps/web/next.config.mjs) to `apps/api`'s
// `/v1/:path*` routes. Bare `${serverUrl}/v1/...` 404s against the web
// origin (C2). Derive the api base ONCE here and use it for every api call
// (device-auth fetches + the agent's --api-base-url); keep the raw
// `serverUrl` origin only for user-facing links (the dashboard success
// message).
export function deriveApiBase(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

// Builds the argv passed to the Go agent's `enroll` subcommand. Kept as a
// standalone pure function so the TS↔Go flag contract (agent/internal/cli/enroll.go)
// is unit-testable without spawning the real binary — the agent has NO
// `--server` flag (that was the bug this guards against); the real flag is
// `--api-base-url`, and `--insecure` is required to allow a non-https (e.g.
// local dev http://) API base URL.
//
// Flag/positional order matters (M1): the enrollment token is base64url, so
// it can legitimately start with `-` (e.g. "-abc123"), which cobra/pflag
// would otherwise parse as an unknown flag. All flags are emitted first,
// followed by `--` (end-of-flags), with the token as the sole trailing
// positional arg — cobra's `ExactArgs(1)` accepts this standard form.
//
// `--force` (H3) is always passed: the device-auth flow that produced this
// enrollment token was just freshly approved by the user in the browser —
// that approval IS the consent `--force` exists to gate, so a stale local
// enrollment (half-failed prior login, admin-revoked device, plain re-run)
// must never dead-end the CLI on the agent's "already enrolled" refusal.
export function buildEnrollArgs(enrollmentToken: string, apiBase: string): string[] {
  const args = [
    "enroll",
    "--api-base-url",
    apiBase,
    "--yes",
    "--watch-all",
    "--mode",
    "full-body",
    "--force",
  ];
  if (apiBase.startsWith("http://")) {
    args.push("--insecure");
  }
  args.push("--", enrollmentToken);
  return args;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const serverUrl = (opts.server ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  const apiBase = deriveApiBase(serverUrl);
  const { platform, arch } = resolvePlatform();

  // 1. Device-code authorization
  log(chalk.dim("Requesting device authorization…"));
  const start = await startDeviceAuth(apiBase, {
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
  const enrollmentToken = await pollUntilApproved(apiBase, start);
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
  const enroll = spawnSync(binPath, buildEnrollArgs(enrollmentToken, apiBase), { stdio: "inherit" });
  if (enroll.status !== 0) throw new Error("Agent enrollment failed.");

  // 4. Install the resident service (macOS launchd; other platforms print guidance)
  if (platform === "darwin") {
    const svc = spawnSync(binPath, ["install-service"], { stdio: "inherit" });
    if (svc.status !== 0) throw new Error("Failed to install the launchd service.");
  } else {
    log(
      chalk.yellow(
        `Linux: resident mode not auto-installed. Run \`${binPath} run\` to keep it running (or add a systemd user unit).`,
      ),
    );
  }

  saveCliState({ serverUrl, agentVersion: AGENT_TAG, binaryPath: binPath });
  log("");
  log(chalk.green.bold("✓ caliber is now recording your Claude Code / Codex sessions."));
  log(chalk.dim(`  Backfilling the past 90 days. Dashboard: ${serverUrl}/dashboard/devices`));
  log(chalk.dim("  Pause anytime with `caliber agent pause`."));
}

// logoutCommand must not claim success (or delete local login state) unless
// the agent actually revoked the device (H2). Previously both spawnSync
// results were discarded: the Go agent's `uninstall` prompts "Continue?
// [y/N]" without `--yes` and exits non-zero (130) on a declined/non-TTY
// answer, so logout could print "✓ Logged out" while the device stayed
// enrolled server-side, the keychain entry and config were untouched, and
// (on Linux) a foreground `run` kept uploading — yet cli.json was already
// gone, leaving no local trace that anything had gone wrong.
//
// `--yes` is passed to `uninstall` (never to `uninstall-service`, which
// takes no flags and never prompts): running `caliber logout` at all IS the
// user's consent to revoke. Only a successful revoke (`uninstall` exit 0)
// clears local state; a failed uninstall-service is a soft warning (the
// resident launchd job may keep running) but does not by itself block the
// exit-0 gate below, since the agent's own uninstall step tears down the
// same files uninstall-service manages.
export function logoutCommand(): void {
  const state = loadCliState();
  const binPath = state?.binaryPath ?? agentBinaryPath();
  let revoked = true;
  if (existsSync(binPath)) {
    if (process.platform === "darwin") {
      const svc = spawnSync(binPath, ["uninstall-service"], { stdio: "inherit" });
      if (svc.status !== 0) {
        log(chalk.yellow("Warning: failed to remove the launchd service; it may still be running."));
      }
    }
    const uninstall = spawnSync(binPath, ["uninstall", "--yes"], { stdio: "inherit" });
    revoked = uninstall.status === 0;
  }
  if (!revoked) {
    process.stderr.write(
      chalk.red(
        "✗ Logout incomplete — device may not be revoked; revoke it in the dashboard.\n",
      ),
    );
    process.exitCode = 1;
    return;
  }
  clearCliState();
  // Spec §logout: also remove ~/.caliber/bin (the downloaded agent binary),
  // not just cli.json (clearCliState only deletes the latter).
  rmSync(join(cliStateDir(), "bin"), { recursive: true, force: true });
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
