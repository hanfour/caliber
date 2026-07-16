import { describe, it, expect } from "vitest";
import {
  computeDeliveryMetrics,
  type DeliveryPullInput,
  type DeliveryReviewInput,
  type DeliveryIssueInput,
  type DeliveryProjectItemInput,
} from "../../src/delivery/metrics";

const ME = 777;
const WINDOW = { start: new Date("2026-06-16T00:00:00Z"), end: new Date("2026-07-16T00:00:00Z") }; // 30d

const pull = (o: Partial<DeliveryPullInput> = {}): DeliveryPullInput => ({
  ghNodeId: "PR_1", authorGhId: ME, draft: false,
  ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
  mergedAt: new Date("2026-07-02T00:00:00Z"),
  ...o,
});
const review = (o: Partial<DeliveryReviewInput> = {}): DeliveryReviewInput => ({
  reviewerGhId: ME, prGhNodeId: "PR_X", prAuthorGhId: 5,
  submittedAt: new Date("2026-07-03T00:00:00Z"),
  ...o,
});
const issue = (o: Partial<DeliveryIssueInput> = {}): DeliveryIssueInput => ({
  assigneeGhIds: [ME], closedByGhId: null,
  ghCreatedAt: new Date("2026-06-30T00:00:00Z"),
  closedAt: new Date("2026-07-02T00:00:00Z"),
  ...o,
});
const item = (o: Partial<DeliveryProjectItemInput> = {}): DeliveryProjectItemInput => ({
  assigneeGhIds: [ME], isDone: true, ghUpdatedAt: new Date("2026-07-05T00:00:00Z"),
  ...o,
});

const compute = (o: Partial<Parameters<typeof computeDeliveryMetrics>[0]> = {}) =>
  computeDeliveryMetrics({ ghUserId: ME, window: WINDOW, pulls: [], reviews: [], issues: [], projectItems: [], ...o });

describe("computeDeliveryMetrics", () => {
  it("counts merged PRs, excluding drafts, other authors, unmerged, and out-of-window", () => {
    const r = compute({
      pulls: [
        pull(),                                                        // counts
        pull({ ghNodeId: "PR_2", draft: true }),                       // draft → no
        pull({ ghNodeId: "PR_3", authorGhId: 5 }),                     // not me → no
        pull({ ghNodeId: "PR_4", mergedAt: null }),                    // unmerged → no
        pull({ ghNodeId: "PR_5", mergedAt: new Date("2026-06-01T00:00:00Z") }), // before window → no
      ],
    });
    expect(r.values.merged_pr_count).toBe(1);
    expect(r.windowDays).toBe(30);
  });

  it("computes the lead-time median in hours over exactly the counted PRs (odd/even)", () => {
    const r = compute({
      pulls: [
        pull({ ghNodeId: "A", ghCreatedAt: new Date("2026-07-01T00:00:00Z"), mergedAt: new Date("2026-07-01T10:00:00Z") }), // 10h
        pull({ ghNodeId: "B", ghCreatedAt: new Date("2026-07-01T00:00:00Z"), mergedAt: new Date("2026-07-02T00:00:00Z") }), // 24h
      ],
    });
    expect(r.values.pr_lead_time_hours_median).toBe(17); // mean of 10 and 24
  });

  it("median is absent (not 0) when there are no merged PRs", () => {
    const r = compute({ pulls: [pull({ mergedAt: null })] });
    expect(r.values.merged_pr_count).toBe(0);
    expect(r.values.pr_lead_time_hours_median).toBeUndefined();
  });

  it("issues count via closedBy OR assignee; resolution median in days", () => {
    const r = compute({
      issues: [
        issue(),                                                            // assignee → counts (2d)
        issue({ assigneeGhIds: [], closedByGhId: ME,
                ghCreatedAt: new Date("2026-06-28T00:00:00Z"),
                closedAt: new Date("2026-07-04T00:00:00Z") }),              // closedBy → counts (6d)
        issue({ assigneeGhIds: [9], closedByGhId: 9 }),                     // not me → no
        issue({ closedAt: null }),                                          // open → no
      ],
    });
    expect(r.values.issues_closed_count).toBe(2);
    expect(r.values.issue_resolution_days_median).toBe(4); // mean of 2 and 6
  });

  it("excludes self-reviews and counts distinct PRs reviewed", () => {
    const r = compute({
      reviews: [
        review({ prGhNodeId: "P1" }),
        review({ prGhNodeId: "P1" }),                          // same PR → distinct=1
        review({ prGhNodeId: "P2", prAuthorGhId: ME }),        // self-review → excluded
        review({ prGhNodeId: "P3", reviewerGhId: 5 }),         // not me → excluded
        review({ prGhNodeId: "P4", prAuthorGhId: null }),      // ghost author ≠ self → counts
      ],
    });
    expect(r.values.reviews_submitted).toBe(3);
    expect(r.values.distinct_prs_reviewed).toBe(2); // P1, P4
  });

  it("project items need isDone + assignee + window", () => {
    const r = compute({
      projectItems: [
        item(),
        item({ isDone: false }),
        item({ assigneeGhIds: [9] }),
        item({ ghUpdatedAt: new Date("2026-05-01T00:00:00Z") }),
      ],
    });
    expect(r.values.project_items_completed).toBe(1);
  });

  it("totalEvents = mergedPRs + issuesClosed + reviewsSubmitted; windowDays floors at 1", () => {
    const r = compute({ pulls: [pull()], issues: [issue()], reviews: [review()] });
    expect(r.totalEvents).toBe(3);
    const tiny = computeDeliveryMetrics({
      ghUserId: ME,
      window: { start: new Date("2026-07-16T00:00:00Z"), end: new Date("2026-07-16T06:00:00Z") },
      pulls: [], reviews: [], issues: [], projectItems: [],
    });
    expect(tiny.windowDays).toBe(1);
  });
});
