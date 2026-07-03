#!/usr/bin/env node

import { Command } from "commander";
import dayjs from "dayjs";
import { writeFileSync } from "fs";
import chalk, { Chalk } from "chalk";

import {
  extractSessions as extractClaudeSessions,
  extractFacets,
  extractCosts,
  scanConversationSignals,
} from "./extractors/claude-code.js";
import {
  extractSessions as extractCodexSessions,
  extractSessionInsights as extractCodexSessionInsights,
  scanThreadSignals as scanCodexThreadSignals,
} from "./extractors/codex.js";
import { analyzeUsage } from "./analyzers/usage.js";
import { analyzeSection } from "./analyzers/section.js";
import { getDefaultStandardTemplateText, loadStandard } from "./standard.js";
import {
  renderTextReport,
  renderJsonReport,
  renderMarkdownReport,
  renderHtmlReport,
} from "./reporters/report.js";
import { checkDataQuality } from "./data-quality.js";
import { resolvePresetPeriod } from "./period.js";
import {
  loadConfig,
  saveConfig,
  setConfigValue,
  resetConfig,
  getConfigPath,
  getDefaultConfig,
} from "./config.js";
import type { AppConfig } from "./config.js";
import type { EvalReport, CliOptions } from "./types.js";
import {
  localizeHeadline,
  localizeObservationTokens,
  localizeOverallAssessment,
  localizeRecommendations,
  localizeSectionScoreLine,
  t,
} from "./i18n.js";
import { loginCommand, logoutCommand, agentPassthrough } from "./login/commands.js";

const program = new Command();

program
  .name("caliber")
  .description(
    "AI Development Performance Evaluator\n" +
      "Analyze Claude Code & Codex usage for technical performance review\n" +
      "以技術績效審核者角色，分析 AI 工具使用狀況並產出評核報告",
  )
  .version("0.1.0");

// ── Config command ──

const configCmd = program
  .command("config")
  .description("View or modify settings / 檢視或修改設定");

configCmd
  .command("show", { isDefault: true })
  .description("Show current configuration / 顯示目前設定")
  .action(() => {
    const config = loadConfig();
    const defaults = getDefaultConfig();
    const dict = t(config.locale);
    console.log("");
    console.log(chalk.bold(dict.configTitle));
    console.log(chalk.dim(`${dict.configFile}: ${getConfigPath()}`));
    console.log("");
    for (const [key, value] of Object.entries(config)) {
      const isDefault = value === defaults[key as keyof AppConfig];
      const label = isDefault ? chalk.dim(dict.defaultLabel) : chalk.green(dict.customLabel);
      console.log(`  ${chalk.bold(key)}: ${value} ${label}`);
    }
    console.log("");
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value / 設定值")
  .action((key: string, value: string) => {
    try {
      const config = loadConfig();
      const dict = t(config.locale);
      const updated = setConfigValue(config, key, value);
      saveConfig(updated);
      console.log(chalk.green(`${dict.setOk} ${key} = ${value}`));
    } catch (err) {
      console.error(
        chalk.red(err instanceof Error ? err.message : String(err)),
      );
      process.exitCode = 1;
    }
  });

configCmd
  .command("reset")
  .description("Reset all settings to defaults / 重設為預設值")
  .action(() => {
    const config = loadConfig();
    const dict = t(config.locale);
    resetConfig();
    console.log(chalk.green(dict.configReset));
  });

configCmd
  .command("path")
  .description("Show config file path / 顯示設定檔路徑")
  .action(() => {
    console.log(getConfigPath());
  });

// ── Report command ──

program
  .command("report")
  .description("Generate evaluation report / 產出評核報告")
  .option("-s, --since <date>", "Start date (YYYY-MM-DD)")
  .option("-u, --until <date>", "End date (YYYY-MM-DD)")
  .option("-f, --format <format>", "Output format: text, json, markdown, html")
  .option("-o, --output <file>", "Write report to file")
  .option(
    "--standard <path>",
    "Path to custom evaluation standard JSON (default: built-in OneAD)",
  )
  .option("--engineer <name>", "Engineer name for report identification")
  .option("--department <name>", "Department name for report identification")
  .action((opts: CliOptions, cmd: Command) => {
    const config = loadConfig();
    const resolved = resolveCliOpts(opts, cmd, config);
    runReport(resolved, config);
  });

// ── Monthly command ──

program
  .command("monthly")
  .description("Generate monthly KPI report / 產出月度 KPI 評核報告")
  .option("-f, --format <format>", "Output format: text, json, markdown, html")
  .option("-o, --output <file>", "Write report to file")
  .option(
    "--standard <path>",
    "Path to custom evaluation standard JSON (default: built-in OneAD)",
  )
  .option("--previous", "Use the previous full calendar month")
  .action((opts: CliOptions, cmd: Command) => {
    const config = loadConfig();
    const resolved = resolveCliOpts(opts, cmd, config);
    runReport(
      {
        ...resolved,
        ...resolvePresetPeriod("monthly", opts.previous ?? false),
      },
      config,
    );
  });

// ── Quarterly command ──

program
  .command("quarterly")
  .description("Generate quarterly KPI report / 產出季度 KPI 評核報告")
  .option("-f, --format <format>", "Output format: text, json, markdown, html")
  .option("-o, --output <file>", "Write report to file")
  .option(
    "--standard <path>",
    "Path to custom evaluation standard JSON (default: built-in OneAD)",
  )
  .option("--previous", "Use the previous full calendar quarter")
  .action((opts: CliOptions, cmd: Command) => {
    const config = loadConfig();
    const resolved = resolveCliOpts(opts, cmd, config);
    runReport(
      {
        ...resolved,
        ...resolvePresetPeriod("quarterly", opts.previous ?? false),
      },
      config,
    );
  });

// ── Summary command ──

program
  .command("summary")
  .description("Quick usage summary / 快速使用摘要")
  .option("-s, --since <date>", "Start date (YYYY-MM-DD)")
  .option("-u, --until <date>", "End date (YYYY-MM-DD)")
  .action((opts: { since?: string; until?: string }) => {
    const config = loadConfig();
    const since = opts.since ?? dayjs().subtract(7, "day").format("YYYY-MM-DD");
    const until = opts.until ?? dayjs().format("YYYY-MM-DD");
    runSummary(since, until, config);
  });

// ── Init-standard command ──

program
  .command("init-standard")
  .description(
    "Export default evaluation standard as a starting template / 匯出預設評核標準範本",
  )
  .option("-o, --output <file>", "Output file path", "eval-standard.json")
  .action((opts: { output: string }) => {
    const config = loadConfig();
    const dict = t(config.locale);
    writeFileSync(opts.output, getDefaultStandardTemplateText(), "utf-8");
    process.stderr.write(
      chalk.green(`${dict.defaultStandardExported} ${opts.output}`) + "\n",
    );
    process.stderr.write(
      chalk.dim(dict.defaultStandardHint) + "\n",
    );
  });

// ── Login / logout / agent commands ──

program
  .command("login")
  .description("Log in and start recording Claude Code / Codex usage on this machine")
  .option("--server <url>", "Caliber server URL")
  .action(async (opts: { server?: string }) => {
    try {
      await loginCommand(opts);
    } catch (err) {
      process.stderr.write(chalk.red(err instanceof Error ? err.message : String(err)) + "\n");
      process.exitCode = 1;
    }
  });

program
  .command("logout")
  .description("Stop recording and remove the local agent")
  .action(() => {
    try {
      logoutCommand();
    } catch (err) {
      process.stderr.write(chalk.red(err instanceof Error ? err.message : String(err)) + "\n");
      process.exitCode = 1;
    }
  });

const agentCmd = program.command("agent").description("Control the local recording agent");
for (const sub of ["status", "pause", "resume"] as const) {
  agentCmd
    .command(sub)
    .description(`${sub} the local recording agent`)
    .action(() => agentPassthrough(sub));
}

// Default: show help
program.action(() => {
  program.help();
});

// ── CLI option resolution (config defaults + CLI overrides) ──

function resolveCliOpts(
  opts: CliOptions,
  cmd: Command,
  config: AppConfig,
): CliOptions {
  const isFromCli = (name: string) => cmd.getOptionValueSource(name) === "cli";

  return {
    ...opts,
    since: isFromCli("since")
      ? opts.since
      : (opts.since ??
        dayjs().subtract(config.defaultPeriodDays, "day").format("YYYY-MM-DD")),
    until: isFromCli("until")
      ? opts.until
      : (opts.until ?? dayjs().format("YYYY-MM-DD")),
    format: isFromCli("format")
      ? opts.format
      : (opts.format ?? config.defaultFormat),
  };
}

// ── Report runner ──

function runReport(opts: CliOptions, config: AppConfig): void {
  const {
    since = dayjs()
      .subtract(config.defaultPeriodDays, "day")
      .format("YYYY-MM-DD"),
    until = dayjs().format("YYYY-MM-DD"),
    format = config.defaultFormat,
    output,
    standard: standardPath,
  } = opts;

  const useColor = config.theme !== "no-color";
  const c = useColor ? chalk : new Chalk({ level: 0 });
  const dict = t(config.locale);
  const log = (msg: string) => process.stderr.write(msg + "\n");

  // Load standard
  const standard = loadStandard(standardPath);
  if (standardPath) {
    log(c.dim(`\nUsing custom standard: ${standardPath}`));
  }
  log(c.dim(`${dict.standardLabel}: ${standard.name}`));
  log(c.dim(`${dict.extractingLabel} ${since} to ${until}...\n`));

  // ── Extract ──
  const claudeSessions = extractClaudeSessions(since, until, config.claudeDir);
  const codexSessions = extractCodexSessions(since, until, config.codexDir);
  const sessionIds = new Set(claudeSessions.map((s) => s.sessionId));
  const facets = extractFacets(sessionIds, config.claudeDir);
  const costs = extractCosts(since, until, config.claudeDir);
  const conversationSignals = scanConversationSignals(
    sessionIds,
    standard,
    50,
    config.claudeDir,
  );
  const codexInsights = extractCodexSessionInsights(
    codexSessions,
    config.codexDir,
  );
  const codexSignals = scanCodexThreadSignals(
    codexSessions,
    codexInsights,
    standard,
  );

  log(
    c.dim(
      `  Claude Code: ${claudeSessions.length} sessions, ${facets.size} facets, ${conversationSignals.length} signals`,
    ),
  );
  log(
    c.dim(
      `  Codex: ${codexSessions.length} sessions, ${codexSignals.length} signals`,
    ),
  );

  // ── Analyze ──
  const usage = analyzeUsage(
    claudeSessions,
    costs,
    codexSessions,
    since,
    until,
  );

  const sections = standard.sections.map((sec) =>
    analyzeSection(
      sec,
      claudeSessions,
      facets,
      conversationSignals,
      codexSessions,
      codexInsights,
      codexSignals,
    ),
  );

  // ── Data quality ──
  const dataWarnings = checkDataQuality(
    claudeSessions.length,
    codexSessions.length,
    facets.size,
    conversationSignals.length,
    config.claudeDir,
    config.codexDir,
  );

  if (dataWarnings.length > 0) {
    log(c.yellow(`  ${dict.dataWarningsCount}: ${dataWarnings.length}`));
  }

  // ── Report ──
  const meta =
    opts.engineer || opts.department
      ? { engineer: opts.engineer, department: opts.department }
      : undefined;

  const report: EvalReport = {
    generatedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    period: { since, until },
    standardName: standard.name,
    locale: config.locale,
    meta,
    usage,
    sections,
    dataWarnings,
    managementSummary: buildManagementSummary(config.locale, sections, usage, since, until),
  };

  let rendered: string;
  switch (format) {
    case "json":
      rendered = renderJsonReport(report);
      break;
    case "markdown":
      rendered = renderMarkdownReport(report, config.locale);
      break;
    case "html":
      rendered = renderHtmlReport(report, config.locale);
      break;
    default:
      rendered = renderTextReport(report, config.locale);
      break;
  }

  if (output) {
    writeFileSync(output, rendered, "utf-8");
    log(c.green(`\n${dict.reportWritten} ${output}`));
  } else {
    process.stdout.write(rendered + "\n");
  }
}

function buildManagementSummary(
  locale: AppConfig["locale"],
  sections: EvalReport["sections"],
  usage: EvalReport["usage"],
  since: string,
  until: string,
): EvalReport["managementSummary"] {
  const superiorCount = sections.filter(
    (section) => section.score > 100,
  ).length;
  const headline = localizeHeadline(locale, superiorCount, sections.length);
  const overallAssessment = localizeOverallAssessment(
    locale,
    since,
    until,
    usage,
    superiorCount,
    sections.length,
  );
  const observations = [
    ...localizeObservationTokens(locale, usage),
    ...sections.map((section) => localizeSectionScoreLine(locale, section)),
  ];
  const recommendations = localizeRecommendations(locale, sections);

  return {
    headline,
    overallAssessment,
    observations,
    recommendations,
  };
}

function runSummary(since: string, until: string, config: AppConfig): void {
  const claudeSessions = extractClaudeSessions(since, until, config.claudeDir);
  const codexSessions = extractCodexSessions(since, until, config.codexDir);

  console.log("");
  console.log(chalk.bold("AI Dev Usage Summary"));
  console.log(chalk.dim(`Period: ${since} ~ ${until}`));
  console.log("");

  console.log(chalk.bold.blue("Claude Code"));
  if (claudeSessions.length === 0) {
    console.log(chalk.dim("  No sessions found."));
  } else {
    const totalTokens = claudeSessions.reduce(
      (sum, s) => sum + s.inputTokens + s.outputTokens,
      0,
    );
    const totalDuration = claudeSessions.reduce(
      (sum, s) => sum + s.durationMinutes,
      0,
    );
    const days = new Set(
      claudeSessions.map((s) => dayjs(s.startTime).format("YYYY-MM-DD")),
    );
    console.log(`  Sessions:    ${claudeSessions.length}`);
    console.log(`  Tokens:      ${totalTokens.toLocaleString("en-US")}`);
    console.log(`  Duration:    ${totalDuration} min`);
    console.log(`  Active Days: ${days.size}`);
  }

  console.log("");
  console.log(chalk.bold.green("Codex"));
  if (codexSessions.length === 0) {
    console.log(chalk.dim("  No sessions found."));
  } else {
    const totalTokens = codexSessions.reduce((sum, s) => sum + s.tokensUsed, 0);
    const days = new Set(
      codexSessions.map((s) => dayjs.unix(s.createdAt).format("YYYY-MM-DD")),
    );
    console.log(`  Sessions:    ${codexSessions.length}`);
    console.log(`  Tokens:      ${totalTokens.toLocaleString("en-US")}`);
    console.log(`  Active Days: ${days.size}`);
  }

  console.log("");
  console.log(chalk.dim("Run `caliber report` for full evaluation report."));
  console.log("");
}

program.parse();
