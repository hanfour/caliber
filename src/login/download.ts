import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

export function resolvePlatform(): { platform: "darwin" | "linux"; arch: "arm64" | "amd64" } {
  // Anything other than darwin/linux (e.g. Windows) previously fell through
  // to "linux" silently, so a Windows member would get a linux tarball and
  // an `xdg-open` call that doesn't exist on their machine. Fail loudly
  // instead — there's no macOS/Linux binary release to fall back to.
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Unsupported platform "${process.platform}": caliber login supports macOS and Linux only.`);
  }
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { platform, arch };
}

// SAFE_TAG replaces "/" with "_": agent/v0.2.0 -> agent_v0.2.0
export function assetName(agentTag: string, platform: string, arch: string): string {
  const safe = agentTag.replace(/\//g, "_");
  return `caliber-agent-${safe}-${platform}-${arch}.tar.gz`;
}

export function assetUrl(repo: string, agentTag: string, name: string): string {
  // repo e.g. "hanfour/caliber"; release tag keeps the slash: .../download/agent/v0.2.0/<name>
  return `https://github.com/${repo}/releases/download/${agentTag}/${name}`;
}

export function verifySha256(filePath: string, expectedHex: string): boolean {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return hash.toLowerCase() === expectedHex.trim().toLowerCase().split(/\s+/)[0];
}

export async function downloadTo(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

export async function fetchSha256(sha256Url: string): Promise<string> {
  const res = await fetch(sha256Url);
  if (!res.ok) throw new Error(`sha256 fetch failed (HTTP ${res.status})`);
  return (await res.text()).trim().split(/\s+/)[0];
}

export async function downloadAndVerify(url: string, sha256Url: string, destTar: string): Promise<void> {
  await downloadTo(url, destTar);
  const expected = await fetchSha256(sha256Url);
  if (!verifySha256(destTar, expected)) {
    // This function is the supply-chain security gate: never leave a
    // tampered/corrupt tarball behind at a deterministic path.
    await rm(destTar, { force: true });
    throw new Error(`sha256 mismatch for ${destTar} (expected ${expected})`);
  }
}

// Extract the single `caliber-agent` binary from the tarball via system tar
// (available on macOS + Linux; avoids a tar npm dependency).
export async function extractBinary(tarPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarPath, "-C", destDir, "caliber-agent"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("failed to extract caliber-agent from tarball");
}
