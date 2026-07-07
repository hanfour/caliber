import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/**
 * Merge the Caliber gateway env into ~/.claude/settings.json so Claude Code
 * routes through the gateway (#256). Preserves every other setting and env
 * var — only sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. Returns whether
 * an existing gateway config was overwritten (for user-facing messaging).
 *
 * ANTHROPIC_AUTH_TOKEN (Bearer) is used, not ANTHROPIC_API_KEY — the gateway
 * accepts both, and AUTH_TOKEN avoids Claude Code's one-time approval prompt
 * and the 401-churn that ANTHROPIC_API_KEY triggers.
 */
export function writeClaudeGatewayConfig(
  apiKey: string,
  gatewayUrl: string,
  path: string = claudeSettingsPath(),
): { existedBefore: boolean } {
  let settings: Record<string, unknown> = {};
  let existedBefore = false;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") settings = parsed;
    } catch {
      // Unparseable settings.json — back off rather than clobber the user's
      // file; the caller surfaces guidance to configure manually.
      throw new Error(
        `~/.claude/settings.json is not valid JSON; not modifying it. Set ANTHROPIC_BASE_URL=${gatewayUrl} and ANTHROPIC_AUTH_TOKEN manually.`,
      );
    }
  }

  const env =
    settings.env && typeof settings.env === "object"
      ? (settings.env as Record<string, unknown>)
      : {};
  existedBefore = "ANTHROPIC_BASE_URL" in env || "ANTHROPIC_AUTH_TOKEN" in env;

  const nextEnv = { ...env, ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_AUTH_TOKEN: apiKey };
  const next = { ...settings, env: nextEnv };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return { existedBefore };
}
