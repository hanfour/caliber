/**
 * Pure delivery metric computation (spec 2026-07-15 Component 3).
 * Inputs are narrow structs (the gateway worker maps DB rows to these);
 * no I/O, no mutation. Medians are ABSENT (undefined) when there are no
 * samples — never 0, which would wrongly score as instant delivery on
 * inverted curves.
 */
import type { DeliveryMetricKey } from "./rubric.js";

export interface DeliveryPullInput {
  ghNodeId: string;
  authorGhId: number | null;
  draft: boolean;
  ghCreatedAt: Date;
  mergedAt: Date | null;
}

export interface DeliveryReviewInput {
  reviewerGhId: number | null;
  prGhNodeId: string;
  prAuthorGhId: number | null;
  submittedAt: Date;
}

export interface DeliveryIssueInput {
  assigneeGhIds: number[];
  closedByGhId: number | null;
  ghCreatedAt: Date;
  closedAt: Date | null;
}

export interface DeliveryProjectItemInput {
  assigneeGhIds: number[];
  isDone: boolean;
  ghUpdatedAt: Date;
}

export interface DeliveryWindow {
  start: Date;
  end: Date;
}

export interface DeliveryMetricsResult {
  windowDays: number;
  values: Partial<Record<DeliveryMetricKey, number>>;
  totalEvents: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function within(t: Date, w: DeliveryWindow): boolean {
  return t.getTime() >= w.start.getTime() && t.getTime() <= w.end.getTime();
}

function median(samples: number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeDeliveryMetrics(input: {
  ghUserId: number;
  window: DeliveryWindow;
  pulls: DeliveryPullInput[];
  reviews: DeliveryReviewInput[];
  issues: DeliveryIssueInput[];
  projectItems: DeliveryProjectItemInput[];
}): DeliveryMetricsResult {
  const { ghUserId, window } = input;

  const mergedPulls = input.pulls.filter(
    (p) =>
      p.authorGhId === ghUserId &&
      !p.draft &&
      p.mergedAt !== null &&
      within(p.mergedAt, window),
  );

  const closedIssues = input.issues.filter(
    (i) =>
      i.closedAt !== null &&
      within(i.closedAt, window) &&
      (i.closedByGhId === ghUserId || i.assigneeGhIds.includes(ghUserId)),
  );

  const submittedReviews = input.reviews.filter(
    (r) =>
      r.reviewerGhId === ghUserId &&
      within(r.submittedAt, window) &&
      // ghost/unknown PR author (null) is NOT a self-review
      !(r.prAuthorGhId !== null && r.prAuthorGhId === r.reviewerGhId),
  );

  const completedItems = input.projectItems.filter(
    (pi) =>
      pi.isDone &&
      within(pi.ghUpdatedAt, window) &&
      pi.assigneeGhIds.includes(ghUserId),
  );

  const leadTimeMedian = median(
    mergedPulls.map((p) => (p.mergedAt!.getTime() - p.ghCreatedAt.getTime()) / HOUR_MS),
  );
  const resolutionMedian = median(
    closedIssues.map((i) => (i.closedAt!.getTime() - i.ghCreatedAt.getTime()) / DAY_MS),
  );

  const values: Partial<Record<DeliveryMetricKey, number>> = {
    merged_pr_count: mergedPulls.length,
    issues_closed_count: closedIssues.length,
    project_items_completed: completedItems.length,
    reviews_submitted: submittedReviews.length,
    distinct_prs_reviewed: new Set(submittedReviews.map((r) => r.prGhNodeId)).size,
  };
  if (leadTimeMedian !== undefined) values.pr_lead_time_hours_median = leadTimeMedian;
  if (resolutionMedian !== undefined) values.issue_resolution_days_median = resolutionMedian;

  return {
    windowDays: Math.max(
      1,
      Math.round((window.end.getTime() - window.start.getTime()) / DAY_MS),
    ),
    values,
    totalEvents: mergedPulls.length + closedIssues.length + submittedReviews.length,
  };
}
