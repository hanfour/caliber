import { describe, it, expect, vi } from "vitest";
import { execSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import dayjs from "dayjs";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const CLI = join(PROJECT_ROOT, "dist", "cli.js");

/** Run CLI, returning stdout only (stderr is suppressed) */
const run = (args: string, env?: Record<string, string>) =>
  execSync(`node "${CLI}" ${args} 2>/dev/null`, {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });

/** Run CLI, returning stderr only (stdout is suppressed) */
const runStderr = (args: string) =>
  execSync(`node "${CLI}" ${args} 2>&1 1>/dev/null`, {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, NO_COLOR: "1" },
  });

describe("CLI regression (subprocess)", () => {
  it("shows help without error", () => {
    const output = run("--help");
    expect(output).toContain("caliber");
    expect(output).toContain("report");
    expect(output).toContain("summary");
    expect(output).toContain("init-standard");
    expect(output).toContain("monthly");
    expect(output).toContain("quarterly");
    expect(output).toContain("config");
  });

  it("shows version", () => {
    const output = run("--version");
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("summary runs without error", () => {
    const output = run("summary --since 2026-04-01 --until 2026-04-14");
    expect(output).toContain("AI Dev Usage Summary");
    expect(output).toContain("Claude Code");
    expect(output).toContain("Codex");
  });

  it("report text format runs without error", () => {
    const output = run("report --since 2026-04-01 --until 2026-04-14");
    expect(output).toContain("Evaluation Report");
    expect(output).toContain("SCORE RECOMMENDATION");
  });

  it("report json format produces valid JSON on stdout", () => {
    const output = run(
      "report --since 2026-04-01 --until 2026-04-14 --format json",
    );
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("sections");
    expect(parsed).toHaveProperty("dataWarnings");
    expect(parsed).toHaveProperty("managementSummary");
  });

  it("report with --engineer and --department includes meta", () => {
    const output = run(
      'report --since 2026-04-01 --until 2026-04-14 --format json --engineer "John Doe" --department "R&D"',
    );
    const parsed = JSON.parse(output.trim()) as Record<
      string,
      { engineer?: string; department?: string }
    >;
    expect(parsed.meta?.engineer).toBe("John Doe");
    expect(parsed.meta?.department).toBe("R&D");
  });

  it("init-standard exports valid JSON", () => {
    const output = runStderr(
      "init-standard --output /tmp/test-std-export.json",
    );
    expect(output).toContain("Default standard exported");
    const content = execSync("cat /tmp/test-std-export.json", {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("sections");
  });

  it("report html format emits standalone HTML with embedded report data", () => {
    const output = run(
      "report --since 2026-04-01 --until 2026-04-14 --format html",
    );
    expect(output).toContain("<!DOCTYPE html>");
    expect(output).toContain("At a Glance");
    expect(output).toContain("Usage Stats");
  });
});

describe("resolvePresetPeriod", () => {
  async function getResolver() {
    const mod = await import("../src/period.js");
    return mod.resolvePresetPeriod;
  }

  it("monthly current returns start of current month to today", async () => {
    const resolve = await getResolver();
    const result = resolve("monthly", false);
    const expectedStart = dayjs().startOf("month").format("YYYY-MM-DD");
    expect(result.since).toBe(expectedStart);
    expect(result.until).toBe(dayjs().format("YYYY-MM-DD"));
  });

  it("monthly previous returns full previous month", async () => {
    const resolve = await getResolver();
    const result = resolve("monthly", true);
    const prev = dayjs().subtract(1, "month");
    expect(result.since).toBe(prev.startOf("month").format("YYYY-MM-DD"));
    expect(result.until).toBe(prev.endOf("month").format("YYYY-MM-DD"));
  });

  it("quarterly current starts at correct quarter boundary", async () => {
    const resolve = await getResolver();
    const result = resolve("quarterly", false);
    const month = dayjs().month();
    const qStart = Math.floor(month / 3) * 3;
    const expectedStart = dayjs()
      .month(qStart)
      .startOf("month")
      .format("YYYY-MM-DD");
    expect(result.since).toBe(expectedStart);
    expect(result.until).toBe(dayjs().format("YYYY-MM-DD"));
  });

  it("quarterly previous returns correct previous quarter", async () => {
    const resolve = await getResolver();
    const result = resolve("quarterly", true);
    const start = dayjs(result.since);
    const end = dayjs(result.until);
    const startQ = Math.floor(start.month() / 3);
    const endQ = Math.floor(end.month() / 3);
    expect(startQ).toBe(endQ);
    expect(start.date()).toBe(1);
    expect(start.month() % 3).toBe(0);
    const currentQStart = dayjs()
      .month(Math.floor(dayjs().month() / 3) * 3)
      .startOf("month");
    expect(end.isBefore(currentQStart)).toBe(true);
  });
});
