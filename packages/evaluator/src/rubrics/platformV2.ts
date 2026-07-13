import type { Rubric } from "../rubric/schema.js";

/**
 * Platform-default rubric v2.0.0 (docs/RUBRIC_V2_DESIGN.md §5).
 * Continuous facet-based scoring mirroring the ITO quarterly KPI sub-items.
 * Curve params are INITIAL values — recalibrate via dry-run before flipping
 * is_default (see design §8 step 4).
 */
export const platformRubricV2En: Rubric = {
  name: "Platform Default v2 — Continuous Facet Scoring",
  description:
    "Continuous scoring from LLM-judged session facets; mirrors quarterly KPI sub-items (efficiency / risk control / requester satisfaction)",
  version: "2.0.0",
  locale: "en",
  scale: { max: 120, pass: 108 },
  sections: [
    {
      id: "efficiency",
      name: "Efficiency · AI Interaction / 效率·AI交互",
      weight: "25%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_claude_helpfulness",
          id: "helpfulness",
          gte: 3.5,
          points: 50,
          curve: { zeroAt: 2.5, fullAt: 4.5 },
        },
        {
          type: "facet_friction_per_session",
          id: "friction",
          lte: 1.0,
          points: 30,
          curve: { zeroAt: 3.0, fullAt: 0.5 },
        },
        {
          type: "cache_read_ratio",
          id: "cache_reuse",
          gte: 0.2,
          points: 20,
          curve: { zeroAt: 0.1, fullAt: 0.6 },
        },
      ],
    },
    {
      id: "riskControl",
      name: "Quality · AI Risk Control / 品質·AI風控",
      weight: "50%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_bugs_caught",
          id: "bugs_caught_rate",
          gte: 0.2,
          normalize: "per_session",
          points: 45,
          curve: { zeroAt: 0, fullAt: 0.5 },
        },
        {
          type: "facet_codex_errors",
          id: "codex_error_rate",
          lte: 0.5,
          normalize: "per_session",
          points: 30,
          curve: { zeroAt: 1.0, fullAt: 0.1 },
        },
        {
          type: "refusal_rate",
          id: "low_refusal_rate",
          lte: 0.2,
          points: 25,
          curve: { zeroAt: 0.3, fullAt: 0.05 },
        },
      ],
    },
    {
      id: "satisfaction",
      name: "Requester Satisfaction / 需求方滿意",
      weight: "25%",
      scoring: { mode: "continuous" },
      minSamples: 5,
      signals: [
        {
          type: "facet_outcome_success_rate",
          id: "outcome_success",
          gte: 0.6,
          points: 70,
          curve: { zeroAt: 0.4, fullAt: 0.85 },
        },
        {
          type: "facet_user_satisfaction",
          id: "user_satisfaction",
          gte: 3.5,
          points: 30,
          curve: { zeroAt: 2.5, fullAt: 4.5 },
        },
      ],
    },
  ],
  noiseFilters: [
    "<task-notification>",
    "<command-name>",
    "<local-command-caveat>",
    "<system-reminder>",
    "you are a senior code reviewer",
    "you are a code reviewer",
    "perform a deep, multi-dimensional analysis",
    "review the provided pull request",
  ],
};

export const platformRubricV2ZhHant: Rubric = {
  ...platformRubricV2En,
  name: "平台預設 v2 — 連續 facet 計分",
  description:
    "以 LLM 逐 session 判讀的 facets 連續計分；鏡射季評分 KPI 子項（效率／風控／需求方滿意）",
  locale: "zh-Hant",
  sections: platformRubricV2En.sections.map((s) => ({
    ...s,
    name:
      s.id === "efficiency"
        ? "效率·AI交互"
        : s.id === "riskControl"
          ? "品質·AI風控"
          : "需求方滿意",
  })),
};

export const platformRubricV2Ja: Rubric = {
  ...platformRubricV2En,
  name: "プラットフォームデフォルト v2 — 連続ファセットスコアリング",
  description:
    "LLMがセッション毎に判定したファセットによる連続スコアリング；四半期KPIサブ項目（効率／リスク管理／依頼者満足）を反映",
  locale: "ja",
  sections: platformRubricV2En.sections.map((s) => ({
    ...s,
    name:
      s.id === "efficiency"
        ? "効率·AI対話"
        : s.id === "riskControl"
          ? "品質·AIリスク管理"
          : "依頼者満足",
  })),
};
