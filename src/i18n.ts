import type { DataQualityWarning, EvalReport, EvalSectionResult } from "./types.js";

export type AppLocale = "en" | "zh-TW";

interface ReportDict {
  reportTitle: string;
  summaryTitle: string;
  usageTitle: string;
  scoreTitle: string;
  observations: string;
  recommendations: string;
  usageEvidence: string;
  scoreEvidence: string;
  dataWarnings: string;
  generated: string;
  period: string;
  engineer: string;
  department: string;
  sessions: string;
  tokens: string;
  duration: string;
  activeDays: string;
  estimatedCost: string;
  models: string;
  topProjects: string;
  topTools: string;
  noCodexSessions: string;
  scoringSourceNote: string;
  atAGlance: string;
  usageStats: string;
  sections: string;
  reportWritten: string;
  standardLabel: string;
  extractingLabel: string;
  claudeLabel: string;
  codexLabel: string;
  dataWarningsCount: string;
  configTitle: string;
  configFile: string;
  defaultLabel: string;
  customLabel: string;
  configReset: string;
  setOk: string;
  defaultStandardExported: string;
  defaultStandardHint: string;
}

const DICTS: Record<AppLocale, ReportDict> = {
  en: {
    reportTitle: "Evaluation Report",
    summaryTitle: "Management Summary",
    usageTitle: "Usage Overview",
    scoreTitle: "Score Recommendation",
    observations: "Observations",
    recommendations: "Recommendations",
    usageEvidence: "Usage Evidence",
    scoreEvidence: "Score Evidence",
    dataWarnings: "Data Quality Warnings",
    generated: "Generated",
    period: "Period",
    engineer: "Engineer",
    department: "Department",
    sessions: "Sessions",
    tokens: "Tokens",
    duration: "Duration",
    activeDays: "Active Days",
    estimatedCost: "Estimated Cost",
    models: "Models",
    topProjects: "Top Projects",
    topTools: "Top Tools",
    noCodexSessions: "No Codex sessions found.",
    scoringSourceNote:
      "Scoring uses Claude Code facets/conversations plus Codex thread metadata, user prompt history, and tool/error logs.",
    atAGlance: "At a Glance",
    usageStats: "Usage Stats",
    sections: "Sections",
    reportWritten: "Report written to",
    standardLabel: "Standard",
    extractingLabel: "Extracting data from",
    claudeLabel: "Claude Code",
    codexLabel: "Codex",
    dataWarningsCount: "Data warnings",
    configTitle: "Caliber Configuration",
    configFile: "Config file",
    defaultLabel: "(default)",
    customLabel: "(custom)",
    configReset: "Configuration reset to defaults.",
    setOk: "Set",
    defaultStandardExported: "Default standard exported to",
    defaultStandardHint: "Edit this file to create your custom evaluation standard.",
  },
  "zh-TW": {
    reportTitle: "評核報告",
    summaryTitle: "管理摘要",
    usageTitle: "使用概覽",
    scoreTitle: "分值建議",
    observations: "觀察",
    recommendations: "建議",
    usageEvidence: "使用證據",
    scoreEvidence: "評分證據",
    dataWarnings: "資料品質警告",
    generated: "產出時間",
    period: "期間",
    engineer: "工程師",
    department: "部門",
    sessions: "Sessions",
    tokens: "Tokens",
    duration: "使用時長",
    activeDays: "活躍天數",
    estimatedCost: "預估成本",
    models: "模型分布",
    topProjects: "主要專案",
    topTools: "主要工具",
    noCodexSessions: "未找到 Codex sessions。",
    scoringSourceNote:
      "評分依據包含 Claude Code facets / conversations，以及 Codex thread metadata、user prompt history、tool / error logs。",
    atAGlance: "快速總覽",
    usageStats: "使用統計",
    sections: "評核項目",
    reportWritten: "報告已寫入",
    standardLabel: "評核標準",
    extractingLabel: "正在擷取資料",
    claudeLabel: "Claude Code",
    codexLabel: "Codex",
    dataWarningsCount: "資料警告",
    configTitle: "Caliber 設定",
    configFile: "設定檔",
    defaultLabel: "(預設)",
    customLabel: "(自訂)",
    configReset: "設定已重設為預設值。",
    setOk: "已設定",
    defaultStandardExported: "預設標準已匯出至",
    defaultStandardHint: "請編輯此檔案來建立自訂評核標準。",
  },
};

export function t(locale: AppLocale): ReportDict {
  return DICTS[locale];
}

export function localizeHeadline(
  locale: AppLocale,
  superiorCount: number,
  sectionCount: number,
): string {
  if (locale === "zh-TW") {
    if (superiorCount === sectionCount) return "整體 KPI 證據完整，所有評核項目皆達卓越。";
    if (superiorCount > 0) return "KPI 證據呈現混合狀態，部分項目達卓越，但仍有補強空間。";
    return "KPI 證據目前停留在標準水位，仍需更強的決策與風險控管證據。";
  }
  if (superiorCount === sectionCount) {
    return "Overall KPI posture is strong across all configured sections.";
  }
  if (superiorCount > 0) {
    return "KPI evidence is mixed: some sections are superior, but not all.";
  }
  return "KPI evidence remains at standard level; stronger decision and risk evidence is needed.";
}

export function localizeOverallAssessment(
  locale: AppLocale,
  since: string,
  until: string,
  report: EvalReport["usage"],
  superiorCount: number,
  sectionCount: number,
): string {
  if (locale === "zh-TW") {
    return `分析期間為 ${since} 至 ${until}。共分析 ${report.claudeCode.totalSessions} 個 Claude Code sessions 與 ${report.codex.totalSessions} 個 Codex threads，其中 ${sectionCount} 個評核項目中有 ${superiorCount} 個達到 120%。`;
  }
  return `Period ${since} to ${until}. ${report.claudeCode.totalSessions} Claude Code sessions and ${report.codex.totalSessions} Codex threads were analyzed. ${superiorCount}/${sectionCount} sections reached Superior (120%).`;
}

export function localizeObservationTokens(
  locale: AppLocale,
  report: EvalReport["usage"],
): string[] {
  if (locale === "zh-TW") {
    return [
      `Claude Code tokens：${(
        report.claudeCode.totalInputTokens + report.claudeCode.totalOutputTokens
      ).toLocaleString("zh-TW")}。`,
      `Codex tokens：${report.codex.totalTokensUsed.toLocaleString("zh-TW")}。`,
    ];
  }
  return [
    `Claude Code tokens: ${(
      report.claudeCode.totalInputTokens + report.claudeCode.totalOutputTokens
    ).toLocaleString("en-US")}.`,
    `Codex tokens: ${report.codex.totalTokensUsed.toLocaleString("en-US")}.`,
  ];
}

export function localizeSectionScoreLine(
  locale: AppLocale,
  section: EvalSectionResult,
): string {
  if (locale === "zh-TW") {
    return `${section.name}：${section.score}%（${section.label}）。`;
  }
  return `${section.name}: ${section.score}% (${section.label}).`;
}

export function localizeRecommendations(
  locale: AppLocale,
  sections: EvalSectionResult[],
): string[] {
  const recommendations: string[] = [];
  if (sections.some((section) => section.id === "interaction" && section.score <= 100)) {
    recommendations.push(
      locale === "zh-TW"
        ? "建議補強互動決策證據，例如更明確的方案比較、多輪選擇與修正脈絡。"
        : "Strengthen interaction evidence with clearer decision comparisons, iterative choices, and explicit corrections.",
    );
  }
  if (sections.some((section) => section.id === "riskControl" && section.score <= 100)) {
    recommendations.push(
      locale === "zh-TW"
        ? "建議補強風險控管證據，例如更明確的安全、效能與防錯討論。"
        : "Strengthen risk-control evidence with explicit security, performance, and bug-prevention discussions.",
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      locale === "zh-TW"
        ? "請維持目前的證據品質，並持續記錄決策與風險控管 reasoning。"
        : "Maintain current evidence quality and continue documenting decision and risk-control reasoning.",
    );
  }
  return recommendations;
}

export function localizeWarningLabel(locale: AppLocale, warning: DataQualityWarning): string {
  if (locale === "zh-TW") {
    if (warning.severity === "missing") return "缺失";
    if (warning.severity === "error") return "錯誤";
    return "部分缺失";
  }
  if (warning.severity === "missing") return "MISSING";
  if (warning.severity === "error") return "ERROR";
  return "PARTIAL";
}
