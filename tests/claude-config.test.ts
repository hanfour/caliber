import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClaudeGatewayConfig } from "../src/login/claude-config.js";

describe("writeClaudeGatewayConfig (#256)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("creates settings.json with the gateway env when none exists", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    const path = join(dir, "settings.json");
    const { existedBefore } = writeClaudeGatewayConfig("ak_1", "https://gw.x", path);
    expect(existedBefore).toBe(false);
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://gw.x");
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("ak_1");
  });

  it("merges into an existing settings.json without clobbering other keys or env", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ theme: "dark", env: { FOO: "bar" } }),
    );
    const { existedBefore } = writeClaudeGatewayConfig("ak_2", "https://gw.y", path);
    expect(existedBefore).toBe(false); // no prior gateway keys
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.theme).toBe("dark");
    expect(s.env.FOO).toBe("bar");
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://gw.y");
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("ak_2");
  });

  it("reports existedBefore when a gateway config was already present", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old", ANTHROPIC_AUTH_TOKEN: "ak_old" } }),
    );
    const { existedBefore } = writeClaudeGatewayConfig("ak_new", "https://gw.new", path);
    expect(existedBefore).toBe(true);
    const s = JSON.parse(readFileSync(path, "utf-8"));
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("ak_new");
  });

  it("refuses to clobber an unparseable settings.json", () => {
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, "{ not json");
    expect(() => writeClaudeGatewayConfig("ak", "https://gw", path)).toThrow(/not valid JSON/);
    // original left intact
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });
});
