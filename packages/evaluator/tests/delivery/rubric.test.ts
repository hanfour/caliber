import { describe, it, expect } from "vitest";
import {
  DELIVERY_RUBRIC_V1,
  DELIVERY_SECTION_WEIGHTS,
  DELIVERY_SCALE_MAX,
  DELIVERY_MIN_EVENTS,
  DELIVERY_RUBRIC_VERSION,
} from "../../src/delivery/rubric";

describe("DELIVERY_RUBRIC_V1", () => {
  it("has the 7 spec metrics with per-30d curves and correct sections", () => {
    const byKey = Object.fromEntries(DELIVERY_RUBRIC_V1.map((d) => [d.key, d]));
    expect(byKey["merged_pr_count"]).toMatchObject({ section: "throughput", curve: { zeroAt: 0, fullAt: 8 }, kind: "count" });
    expect(byKey["issues_closed_count"]).toMatchObject({ section: "throughput", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" });
    expect(byKey["project_items_completed"]).toMatchObject({ section: "throughput", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" });
    expect(byKey["reviews_submitted"]).toMatchObject({ section: "collaboration", curve: { zeroAt: 0, fullAt: 10 }, kind: "count" });
    expect(byKey["distinct_prs_reviewed"]).toMatchObject({ section: "collaboration", curve: { zeroAt: 0, fullAt: 6 }, kind: "count" });
    // inverted (lower is better) — zeroAt > fullAt
    expect(byKey["pr_lead_time_hours_median"]).toMatchObject({ section: "timeliness", curve: { zeroAt: 168, fullAt: 24 }, kind: "median" });
    expect(byKey["issue_resolution_days_median"]).toMatchObject({ section: "timeliness", curve: { zeroAt: 14, fullAt: 2 }, kind: "median" });
    expect(DELIVERY_RUBRIC_V1).toHaveLength(7);
  });

  it("weights sum to 1 and scale/min-events match the spec", () => {
    expect(DELIVERY_SECTION_WEIGHTS).toEqual({ throughput: 0.4, collaboration: 0.3, timeliness: 0.3 });
    expect(DELIVERY_SCALE_MAX).toBe(120);
    expect(DELIVERY_MIN_EVENTS).toBe(3);
    expect(DELIVERY_RUBRIC_VERSION).toBe("delivery-v1");
  });
});
