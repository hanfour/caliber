// apps/web/src/components/evaluator/rubricThreshold.ts
// Pure formatter: a rubric signal definition → human-readable threshold text.
// Mirrors the discriminated union in packages/evaluator/src/rubric/schema.ts,
// but structural (the report only needs id/type + threshold fields to explain
// "what it takes to hit this signal").

export interface RubricSignal {
  id: string;
  type: string;
  // threshold-family fields (present depending on `type`)
  metric?: string;
  gte?: number;
  lte?: number;
  between?: [number, number];
  minRatio?: number;
  minCount?: number;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatThreshold(signal: RubricSignal): string {
  switch (signal.type) {
    case "keyword":
      return signal.minRatio != null
        ? `≥ ${pct(signal.minRatio)} of bodies contain a term`
        : "any body contains a term";
    case "threshold": {
      const m = signal.metric ?? "metric";
      if (signal.between) return `${m} in [${signal.between[0]}, ${signal.between[1]}]`;
      if (signal.gte != null) return `${m} ≥ ${signal.gte}`;
      if (signal.lte != null) return `${m} ≤ ${signal.lte}`;
      return m;
    }
    case "refusal_rate":
      return `refusal_rate ≤ ${signal.lte}`;
    case "client_mix":
      return `≥ ${pct(signal.minRatio ?? 0)} from expected clients`;
    case "extended_thinking_used":
      return `extended thinking used ≥ ${signal.minCount} times`;
    case "model_diversity":
    case "cache_read_ratio":
    case "tool_diversity":
    case "iteration_count":
      return `${signal.type} ≥ ${signal.gte}`;
    case "facet_claude_helpfulness":
    case "facet_bugs_caught":
    case "facet_outcome_success_rate":
    case "facet_session_type_ratio":
      return `${signal.type} ≥ ${signal.gte}`;
    case "facet_friction_per_session":
    case "facet_codex_errors":
      return `${signal.type} ≤ ${signal.lte}`;
    default:
      return "";
  }
}
