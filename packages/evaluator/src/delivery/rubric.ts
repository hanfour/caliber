/**
 * Delivery rubric v1 (spec 2026-07-15, Component 3). Constants only —
 * no per-org override in v1 (YAGNI per spec). Curves are per-30-day
 * baselines; count metrics scale fullAt linearly with the window,
 * median metrics do not. Inverted curves (zeroAt > fullAt) mean
 * "lower is better" and are handled natively by curveScore.
 */
export type DeliverySectionKey = "throughput" | "collaboration" | "timeliness";

export type DeliveryMetricKey =
  | "merged_pr_count"
  | "issues_closed_count"
  | "project_items_completed"
  | "reviews_submitted"
  | "distinct_prs_reviewed"
  | "pr_lead_time_hours_median"
  | "issue_resolution_days_median";

export interface DeliveryCurve {
  zeroAt: number;
  fullAt: number;
}

export interface DeliveryMetricDef {
  key: DeliveryMetricKey;
  section: DeliverySectionKey;
  curve: DeliveryCurve;
  kind: "count" | "median";
}

export const DELIVERY_SCALE_MAX = 120;
export const DELIVERY_MIN_EVENTS = 3;
export const DELIVERY_RUBRIC_VERSION = "delivery-v1";

export const DELIVERY_SECTION_WEIGHTS: Record<DeliverySectionKey, number> = {
  throughput: 0.4,
  collaboration: 0.3,
  timeliness: 0.3,
};

export const DELIVERY_RUBRIC_V1: readonly DeliveryMetricDef[] = [
  { key: "merged_pr_count", section: "throughput", curve: { zeroAt: 0, fullAt: 8 }, kind: "count" },
  { key: "issues_closed_count", section: "throughput", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" },
  { key: "project_items_completed", section: "throughput", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" },
  { key: "reviews_submitted", section: "collaboration", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" },
  { key: "distinct_prs_reviewed", section: "collaboration", curve: { zeroAt: 0, fullAt: 6 }, kind: "count" },
  { key: "pr_lead_time_hours_median", section: "timeliness", curve: { zeroAt: 168, fullAt: 24 }, kind: "median" },
  { key: "issue_resolution_days_median", section: "timeliness", curve: { zeroAt: 14, fullAt: 2 }, kind: "median" },
];
