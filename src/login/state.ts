import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface CliState {
  readonly serverUrl: string;
  readonly agentVersion: string;
  readonly binaryPath: string;
  readonly accessToken?: string;
}

export function cliStateDir(): string {
  return join(homedir(), ".caliber");
}

export function cliStatePath(): string {
  return join(cliStateDir(), "cli.json");
}

export function agentBinaryPath(): string {
  return join(cliStateDir(), "bin", "caliber-agent");
}

export function loadCliState(): CliState | null {
  const path = cliStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CliState>;
    if (!raw.serverUrl || !raw.agentVersion || !raw.binaryPath) return null;
    return {
      serverUrl: raw.serverUrl,
      agentVersion: raw.agentVersion,
      binaryPath: raw.binaryPath,
      accessToken: raw.accessToken,
    };
  } catch {
    return null;
  }
}

export function saveCliState(state: CliState): void {
  mkdirSync(cliStateDir(), { recursive: true });
  writeFileSync(cliStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearCliState(): void {
  rmSync(cliStatePath(), { force: true });
}
