import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ──

export type Locale = "en" | "zh-TW";
export type Theme = "default" | "minimal" | "no-color";
export type OutputFormat = "text" | "json" | "markdown" | "html";

export interface AppConfig {
  readonly locale: Locale;
  readonly theme: Theme;
  readonly defaultFormat: OutputFormat;
  readonly defaultPeriodDays: number;
  readonly claudeDir: string;
  readonly codexDir: string;
}

// ── Defaults ──

const LOCALES: ReadonlySet<string> = new Set(["en", "zh-TW"]);
const THEMES: ReadonlySet<string> = new Set(["default", "minimal", "no-color"]);
const FORMATS: ReadonlySet<string> = new Set(["text", "json", "markdown", "html"]);

const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  locale: "en",
  theme: "default",
  defaultFormat: "text",
  defaultPeriodDays: 30,
  claudeDir: join(homedir(), ".claude"),
  codexDir: join(homedir(), ".codex"),
});

export function getDefaultConfig(): AppConfig {
  return { ...DEFAULT_CONFIG };
}

// ── Path ──

export function getConfigPath(): string {
  return join(homedir(), ".caliber.json");
}

export function getLegacyConfigPath(): string {
  return join(homedir(), ".aide.json");
}

// ── Validation ──

const VALID_KEYS = new Set<string>(Object.keys(DEFAULT_CONFIG));

function validateKey(key: string): asserts key is keyof AppConfig {
  if (!VALID_KEYS.has(key)) {
    throw new Error(
      `Unknown config key: '${key}'. Valid keys: ${[...VALID_KEYS].join(", ")}`,
    );
  }
}

function validateValue(key: keyof AppConfig, value: string): unknown {
  switch (key) {
    case "locale":
      if (!LOCALES.has(value)) {
        throw new Error(
          `Invalid locale: '${value}'. Must be one of: ${[...LOCALES].join(", ")}`,
        );
      }
      return value;
    case "theme":
      if (!THEMES.has(value)) {
        throw new Error(
          `Invalid theme: '${value}'. Must be one of: ${[...THEMES].join(", ")}`,
        );
      }
      return value;
    case "defaultFormat":
      if (!FORMATS.has(value)) {
        throw new Error(
          `Invalid defaultFormat: '${value}'. Must be one of: ${[...FORMATS].join(", ")}`,
        );
      }
      return value;
    case "defaultPeriodDays": {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        throw new Error(
          `Invalid defaultPeriodDays: '${value}'. Must be a positive integer.`,
        );
      }
      return num;
    }
    case "claudeDir":
    case "codexDir":
      if (!value.trim()) {
        throw new Error(`Invalid ${key}: path must not be empty.`);
      }
      return value;
  }
}

// ── Load / Save ──

function isValidValue(key: keyof AppConfig, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  try {
    const strValue =
      key === "defaultPeriodDays" ? String(value) : String(value);
    validateValue(key, strValue);
    return true;
  } catch {
    return false;
  }
}

function readConfigFile(configPath: string): AppConfig {
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const validated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!VALID_KEYS.has(key)) {
      process.stderr.write(
        `[caliber] config warning: ignoring unknown key '${key}'\n`,
      );
      continue;
    }
    const typedKey = key as keyof AppConfig;
    if (isValidValue(typedKey, value)) {
      validated[key] = value;
    } else {
      process.stderr.write(
        `[caliber] config warning: invalid value for '${key}': ${JSON.stringify(value)}, using default\n`,
      );
    }
  }

  return { ...DEFAULT_CONFIG, ...validated } as AppConfig;
}

function migrateLegacyConfig(legacyPath: string, configPath: string): AppConfig {
  const config = readConfigFile(legacyPath);
  try {
    saveConfig(config);
    process.stderr.write(
      `[caliber] config notice: migrated legacy config from ${legacyPath} to ${configPath}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[caliber] config warning: loaded legacy config from ${legacyPath} but could not write ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return config;
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      return readConfigFile(configPath);
    } catch {
      return getDefaultConfig();
    }
  }

  const legacyPath = getLegacyConfigPath();
  if (existsSync(legacyPath)) {
    try {
      return migrateLegacyConfig(legacyPath, configPath);
    } catch {
      return getDefaultConfig();
    }
  }

  return getDefaultConfig();
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  // Only persist values that differ from defaults
  const partial: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfig>) {
    if (config[key] !== DEFAULT_CONFIG[key]) {
      partial[key] = config[key];
    }
  }
  writeFileSync(configPath, JSON.stringify(partial, null, 2) + "\n", "utf-8");
}

// ── Mutators (immutable) ──

export function setConfigValue(
  config: AppConfig,
  key: string,
  value: string,
): AppConfig {
  validateKey(key);
  const validated = validateValue(key, value);
  return { ...config, [key]: validated };
}

export function resetConfig(): AppConfig {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    unlinkSync(configPath);
  }
  const legacyPath = getLegacyConfigPath();
  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
  }
  return getDefaultConfig();
}
