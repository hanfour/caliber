import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (args: string) =>
  execSync(`node "${CLI}" ${args} 2>&1`, {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, NO_COLOR: "1" },
  });

describe("caliber login/agent CLI surface", () => {
  it("login --help lists the --server flag", () => {
    const out = run("login --help");
    expect(out).toMatch(/--server/);
  });

  it("agent --help lists subcommands", () => {
    const out = run("agent --help");
    expect(out).toMatch(/status/);
    expect(out).toMatch(/pause/);
    expect(out).toMatch(/resume/);
  });

  it("logout --help runs without error", () => {
    const out = run("logout --help");
    expect(out).toMatch(/logout/);
  });
});
