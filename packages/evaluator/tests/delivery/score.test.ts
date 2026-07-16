import { describe, it, expect } from "vitest";
import { scoreDelivery } from "../../src/delivery/score";
import type { DeliveryMetricsResult } from "../../src/delivery/metrics";

const base = (over: Partial<DeliveryMetricsResult> = {}): DeliveryMetricsResult => ({
  windowDays: 30,
  totalEvents: 10,
  values: {},
  ...over,
});

describe("scoreDelivery", () => {
  it("saturated 30d inputs score 120", () => {
    const r = scoreDelivery(base({
      values: {
        merged_pr_count: 8, issues_closed_count: 10, project_items_completed: 10,
        reviews_submitted: 10, distinct_prs_reviewed: 6,
        pr_lead_time_hours_median: 24, issue_resolution_days_median: 2,
      },
    }));
    expect(r.totalScore).toBe(120);
    expect(r.insufficientData).toBe(false);
    expect(r.sections).toHaveLength(3);
  });

  it("scales count curves with the window (90d → fullAt ×3) and never scales medians", () => {
    const r = scoreDelivery(base({
      windowDays: 90,
      values: {
        merged_pr_count: 12,               // vs scaled fullAt 24 → 0.5
        pr_lead_time_hours_median: 24,     // unscaled → 1.0
      },
    }));
    const throughput = r.sections.find((s) => s.key === "throughput")!;
    const mpr = throughput.metrics.find((m) => m.key === "merged_pr_count")!;
    expect(mpr.scaledCurve).toEqual({ zeroAt: 0, fullAt: 24 });
    expect(mpr.subscore).toBeCloseTo(0.5, 5);
    const timeliness = r.sections.find((s) => s.key === "timeliness")!;
    const lead = timeliness.metrics.find((m) => m.key === "pr_lead_time_hours_median")!;
    expect(lead.scaledCurve).toEqual({ zeroAt: 168, fullAt: 24 });
    expect(lead.subscore).toBe(1);
  });

  it("inverted curve: worse-than-zeroAt median scores 0", () => {
    const r = scoreDelivery(base({ values: { pr_lead_time_hours_median: 200 } }));
    const lead = r.sections.find((s) => s.key === "timeliness")!.metrics
      .find((m) => m.key === "pr_lead_time_hours_median")!;
    expect(lead.subscore).toBe(0);
  });

  it("absent medians are excluded; all-absent section renormalizes the total", () => {
    // Only throughput + collaboration have values; timeliness has no medians at all.
    const r = scoreDelivery(base({
      values: {
        merged_pr_count: 8, issues_closed_count: 10, project_items_completed: 10,
        reviews_submitted: 10, distinct_prs_reviewed: 6,
      },
    }));
    const timeliness = r.sections.find((s) => s.key === "timeliness")!;
    expect(timeliness.score).toBeNull();
    // throughput 1.0 (w .4) + collaboration 1.0 (w .3), renormalized over .7 → 120
    expect(r.totalScore).toBe(120);
  });

  it("insufficient data (totalEvents < 3) → totalScore null but sections still computed", () => {
    const r = scoreDelivery(base({
      totalEvents: 2,
      values: { merged_pr_count: 2, issues_closed_count: 0, project_items_completed: 0, reviews_submitted: 0, distinct_prs_reviewed: 0 },
    }));
    expect(r.insufficientData).toBe(true);
    expect(r.totalScore).toBeNull();
    expect(r.sections.find((s) => s.key === "throughput")!.score).not.toBeNull();
  });

  it("mid-range partial credit lands between 0 and 120 and rounds to 1dp", () => {
    const r = scoreDelivery(base({
      values: {
        merged_pr_count: 4,                 // 0.5
        issues_closed_count: 5,             // 0.5
        project_items_completed: 0,         // 0
        reviews_submitted: 5,               // 0.5
        distinct_prs_reviewed: 3,           // 0.5
        pr_lead_time_hours_median: 96,      // (168-96)/(168-24)=0.5
        issue_resolution_days_median: 8,    // (14-8)/(14-2)=0.5
      },
    }));
    // throughput (0.5+0.5+0)/3=1/3; collaboration 0.5; timeliness 0.5
    // total = 120 × (0.4×1/3 + 0.3×0.5 + 0.3×0.5) = 120 × 0.43333 = 52
    expect(r.totalScore).toBe(52);
  });
});
