import { chmodSync, writeFileSync } from "node:fs";
import dayjs from "dayjs";
import {
  rubricSchema,
  scoreWithRules,
  type BodyRow,
  type Report,
  type Rubric,
  type UsageRow,
} from "../packages/evaluator/src/index.js";
import { deriveApiBase } from "./login/commands.js";
import { loadCliState } from "./login/state.js";

interface AdminReportOptions {
  org: string;
  member: string;
  since?: string;
  until?: string;
  format?: string;
  output?: string;
  locale?: "en" | "zh-Hant" | "ja";
}

interface ReportBundle {
  generated_at: string;
  org: { id: string; slug: string; name: string };
  member: { id: string; email: string; name: string | null };
  period: { start: string; end: string };
  rubric: Rubric;
  rubric_meta: { id: string; version: string; source: "org" | "platform" };
  usage_rows: UsageRow[];
  body_rows: BodyRow[];
  source: { session_count: number; event_count: number; turn_count: number };
}

export interface LocalAdminReport {
  generatedAt: string;
  scoredLocally: true;
  org: ReportBundle["org"];
  member: ReportBundle["member"];
  period: ReportBundle["period"];
  rubric: ReportBundle["rubric_meta"] & { name: string };
  source: ReportBundle["source"];
  result: Report;
}

function parseDay(value: string | undefined, fallback: dayjs.Dayjs): dayjs.Dayjs {
  if (!value) return fallback;
  const parsed = dayjs(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !parsed.isValid() || parsed.format("YYYY-MM-DD") !== value) {
    throw new Error(`Invalid date: ${value} (expected YYYY-MM-DD)`);
  }
  return parsed;
}

function period(options: AdminReportOptions): { start: string; end: string } {
  const today = dayjs().startOf("day");
  const start = parseDay(options.since, today.subtract(29, "day")).startOf("day");
  const endInclusive = parseDay(options.until, today).startOf("day");
  if (endInclusive.isBefore(start)) throw new Error("--until must not be before --since");
  if (endInclusive.diff(start, "day") >= 31) throw new Error("Admin reports are limited to 31 days per request.");
  return { start: start.toISOString(), end: endInclusive.add(1, "day").toISOString() };
}

async function fetchBundle(options: AdminReportOptions): Promise<ReportBundle> {
  const state = loadCliState();
  if (!state?.accessToken) {
    throw new Error("Admin CLI authorization is missing or expired. Run `caliber login` and approve it in the browser.");
  }
  const window = period(options);
  const response = await fetch(
    `${deriveApiBase(state.serverUrl)}/v1/cli/admin/report-bundle`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        org: options.org,
        member: options.member,
        period_start: window.start,
        period_end: window.end,
        locale: options.locale,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    if (response.status === 401) throw new Error("CLI authorization expired. Run `caliber login` again.");
    if (response.status === 403) throw new Error("This account does not have report.read_org permission for that organization.");
    if (code === "period_too_large" || code === "bundle_too_large") throw new Error("The selected period contains too much telemetry. Use a shorter date range.");
    if (code === "member_not_found") throw new Error("Member was not found in that organization.");
    throw new Error(`Unable to fetch the report bundle (${code}).`);
  }
  const bundle = body as unknown as ReportBundle;
  bundle.rubric = rubricSchema.parse(bundle.rubric);
  if (!Array.isArray(bundle.usage_rows) || !Array.isArray(bundle.body_rows)) {
    throw new Error("Server returned an invalid report bundle.");
  }
  return bundle;
}

function esc(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderAdminMarkdown(report: LocalAdminReport): string {
  const superior = report.result.sectionScores.filter((section) => section.score === section.superiorScore);
  const concerns = report.result.sectionScores.filter((section) => section.score !== section.superiorScore);
  const lines = [
    `# Admin Performance Report: ${report.member.name ?? report.member.email}`,
    "",
    `- Organization: ${report.org.name} (${report.org.slug})`,
    `- Member: ${report.member.email}`,
    `- Period: ${report.period.start.slice(0, 10)} to ${dayjs(report.period.end).subtract(1, "day").format("YYYY-MM-DD")}`,
    `- Rubric: ${report.rubric.name} v${report.rubric.version} (${report.rubric.source})`,
    `- Generated: ${report.generatedAt}`,
    `- Scoring execution: local CLI`,
    "",
    "## Executive Summary",
    "",
    `Overall score: **${report.result.totalScore === null ? "insufficient data" : `${report.result.totalScore.toFixed(1)} / 120`}** across ${report.source.turn_count} captured human turns in ${report.source.session_count} sessions. Data coverage is ${(report.result.dataQuality.coverageRatio * 100).toFixed(1)}%.`,
    "",
    "## Performance Assessment",
    "",
    "| Dimension | Weight | Score | Level | Signals hit |",
    "| --- | ---: | ---: | --- | ---: |",
    ...report.result.sectionScores.map((section) => {
      const hitCount = section.signals.filter((signal) => signal.hit).length;
      const scoreCell = section.score === null ? "—" : section.score.toFixed(1);
      return `| ${esc(section.name)} | ${section.weight}% | ${scoreCell} | ${esc(section.label)} | ${hitCount}/${section.signals.length} |`;
    }),
    "",
    "## Demonstrated Strengths",
    "",
    ...(superior.length > 0
      ? superior.map((section) => `- ${section.name}: ${section.signals.filter((signal) => signal.hit).map((signal) => signal.id).join(", ") || "superior threshold reached"}`)
      : ["- No dimension reached its superior threshold in this period."]),
    "",
    "## Concerns And Calibration",
    "",
    ...(concerns.length > 0
      ? concerns.map((section) => `- ${section.name}: ${section.signals.filter((signal) => !signal.hit).map((signal) => signal.id).join(", ") || "review qualitative evidence"}`)
      : ["- No below-superior dimensions were identified."]),
    "",
    "## Coaching Plan",
    "",
    ...(concerns.length > 0
      ? concerns.map((section) => `- Prioritize ${section.name}; review the rubric criteria and target the missing signals in the next evaluation window.`)
      : ["- Preserve the demonstrated patterns and calibrate against a broader evaluation window."]),
    "",
    "## Data Limitations",
    "",
    `- This report covers telemetry uploaded before ${report.generatedAt}; activity not yet uploaded by a connected agent is not included.`,
    `- Facet-based signals require server-side facet data; absent facets follow the rubric engine's empty-data rules.`,
    `- Captured requests: ${report.result.dataQuality.capturedRequests}; missing bodies: ${report.result.dataQuality.missingBodies}; truncated bodies: ${report.result.dataQuality.truncatedBodies}.`,
    "",
  ];
  return lines.join("\n");
}

export async function runAdminReport(options: AdminReportOptions): Promise<void> {
  const bundle = await fetchBundle(options);
  if (bundle.source.turn_count === 0) {
    throw new Error("No uploaded scoring data was found for this member in the selected period.");
  }
  const result = scoreWithRules({
    rubric: bundle.rubric,
    usageRows: bundle.usage_rows,
    bodyRows: bundle.body_rows,
    facetRows: [],
  });
  const report: LocalAdminReport = {
    generatedAt: new Date().toISOString(),
    scoredLocally: true,
    org: bundle.org,
    member: bundle.member,
    period: bundle.period,
    rubric: { ...bundle.rubric_meta, name: bundle.rubric.name },
    source: bundle.source,
    result,
  };
  const format = options.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error("--format must be markdown or json");
  }
  const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderAdminMarkdown(report);
  if (options.output) {
    writeFileSync(options.output, rendered, { encoding: "utf-8", mode: 0o600 });
    chmodSync(options.output, 0o600);
  } else {
    process.stdout.write(rendered);
  }
}
