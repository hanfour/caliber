import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_HOME = join(tmpdir(), `caliber-config-test-${process.pid}`);

async function loadConfigModule() {
  vi.resetModules();
  vi.doMock("os", () => ({ homedir: () => TEST_HOME }));
  return import("../src/config.js");
}

describe("config migration", () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    vi.doUnmock("os");
    vi.resetModules();
    vi.restoreAllMocks();
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("uses .caliber.json for new writes", async () => {
    const {
      getDefaultConfig,
      getConfigPath,
      getLegacyConfigPath,
      saveConfig,
      setConfigValue,
    } = await loadConfigModule();

    const config = setConfigValue(getDefaultConfig(), "theme", "no-color");
    saveConfig(config);

    expect(getConfigPath()).toBe(join(TEST_HOME, ".caliber.json"));
    expect(getLegacyConfigPath()).toBe(join(TEST_HOME, ".aide.json"));
    expect(existsSync(getConfigPath())).toBe(true);
    expect(existsSync(getLegacyConfigPath())).toBe(false);
  });

  it("migrates a legacy .aide.json on first load", async () => {
    const { getConfigPath, getLegacyConfigPath, loadConfig } =
      await loadConfigModule();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    writeFileSync(
      getLegacyConfigPath(),
      JSON.stringify({ locale: "zh-TW", defaultPeriodDays: 14 }) + "\n",
      "utf-8",
    );

    const config = loadConfig();
    expect(config.locale).toBe("zh-TW");
    expect(config.defaultPeriodDays).toBe(14);
    expect(existsSync(getConfigPath())).toBe(true);

    const migrated = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(migrated).toMatchObject({
      locale: "zh-TW",
      defaultPeriodDays: 14,
    });
    expect(stderr.mock.calls.join("\n")).toContain("migrated legacy config");

    stderr.mockClear();
    loadConfig();
    expect(stderr.mock.calls.join("\n")).not.toContain("migrated legacy config");
  });

  it("prefers .caliber.json when both config files exist", async () => {
    const { getConfigPath, getLegacyConfigPath, loadConfig } =
      await loadConfigModule();

    writeFileSync(
      getConfigPath(),
      JSON.stringify({ locale: "en", theme: "minimal" }) + "\n",
      "utf-8",
    );
    writeFileSync(
      getLegacyConfigPath(),
      JSON.stringify({ locale: "zh-TW", theme: "no-color" }) + "\n",
      "utf-8",
    );

    const config = loadConfig();
    expect(config.locale).toBe("en");
    expect(config.theme).toBe("minimal");
  });

  it("reset removes both current and legacy config files", async () => {
    const { getConfigPath, getLegacyConfigPath, resetConfig } =
      await loadConfigModule();

    writeFileSync(getConfigPath(), "{}\n", "utf-8");
    writeFileSync(getLegacyConfigPath(), "{}\n", "utf-8");

    resetConfig();

    expect(existsSync(getConfigPath())).toBe(false);
    expect(existsSync(getLegacyConfigPath())).toBe(false);
  });
});
