# GitHub Delivery PR 2 — Quantitative Scoring + Reports + API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 2 of GitHub delivery scoring (spec: `docs/superpowers/specs/2026-07-15-github-delivery-scoring-design.md`, Component 3): pure delivery-rubric scoring in `packages/evaluator/src/delivery/`, a `github-delivery` worker that computes per-member reports into `github_delivery_reports`, a weekly cron, and the `generate`/`getReport`/`listActivity` API — still fully dark behind `ENABLE_GITHUB_DELIVERY`.

**Architecture:** Mirrors the evaluator split: pure scoring lives in `packages/evaluator/src/delivery/` (rubric constants, metric computation, curve scoring — reusing `curveScore` from `engine/continuousScorer.ts`), while the gateway worker (`apps/gateway/src/workers/githubDelivery/`) does I/O: staleness-gated inline `syncOrg`, activity fetch + attribution join, report upsert. API extends the existing `githubDelivery` router with a second injected queue.

**Tech Stack:** Same as PR 1 (TypeScript ESM, Drizzle, BullMQ 5, zod, vitest + testcontainers). NO new migration — all tables shipped in 0032.

## Global Constraints

- Scale max **120**, never summed with the AI-usage score. `DELIVERY_MIN_EVENTS = 3` (merged PRs + closed issues + reviews submitted) below which `insufficient_data = true` and `totalScore = null` — never a zero score.
- Curves are per-30-day baselines: **count metrics scale `fullAt` by `windowDays/30`** (zeroAt 0 stays 0); **median metrics never scale**. `curveScore` from `packages/evaluator/src/engine/continuousScorer.ts:12` handles inverted (`zeroAt > fullAt`) curves natively.
- Exclusions: draft PRs never count; self-reviews (reviewerGhId === PR authorGhId) never count; raw commits are not a metric; line counts are never a metric.
- Attribution: `accounts` where `provider = 'github'` → `Number(providerAccountId)` (composite PK `(provider, providerAccountId)`, schema `packages/db/src/schema/auth.ts:24-44`). Member without a github account row → report row with `insufficient_data = true` + `metrics: { noIdentity: true }`, never an error.
- Report upsert target: `(org_id, user_id, period_start, period_type)` (`github_delivery_reports_org_period_uniq`); `periodType` is always `"daily"` (the evaluator-rerun precedent for arbitrary windows); `llm_status = 'skipped'` in PR 2 (PR 3 fills it).
- jobId: `["ghdel","v1",orgId,userId,periodStart].join("_").replaceAll(":", "-")` — time-bucketed (contains periodStart) so distinct windows never collide. **Manual `generate` does remove-before-add (regeneration must work — PR 1 C1 lesson); the weekly cron does a PLAIN add** (same-Monday repeat ticks are meant to dedup against the completed hash; periodStart is day-aligned so the id is stable all Monday).
- Queue name `github-delivery`, prefix `caliber:gw`, job name `github-delivery`; API-side constants duplicated in lockstep (reports.ts/githubDelivery.ts precedent).
- Everything stays behind `ENABLE_GITHUB_DELIVERY` — wired inside the existing `wireGithubSyncPipeline` (gateway) and the existing api server queue block.
- Commit format: `<type>(<scope>): <description>` — NO Co-Authored-By trailer. Branch: `feat/github-delivery-pr2-scoring` (already created from `04366d9`).
- `noUncheckedIndexedAccess` is on — `!` assertions in tests where forced (established precedent).

---

### Task 1: Delivery rubric constants (`packages/evaluator/src/delivery/rubric.ts`)

**Files:**
- Create: `packages/evaluator/src/delivery/rubric.ts`
- Modify: `packages/evaluator/src/index.ts` (add `export * from "./delivery/rubric.js";` — check the barrel's existing style first; if the package uses subpath exports instead, follow `jobId.ts`'s precedent)
- Test: `packages/evaluator/tests/delivery/rubric.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 7):

```ts
export type DeliverySectionKey = "throughput" | "collaboration" | "timeliness";
export type DeliveryMetricKey =
  | "merged_pr_count" | "issues_closed_count" | "project_items_completed"
  | "reviews_submitted" | "distinct_prs_reviewed"
  | "pr_lead_time_hours_median" | "issue_resolution_days_median";
export interface DeliveryCurve { zeroAt: number; fullAt: number; }
export interface DeliveryMetricDef {
  key: DeliveryMetricKey;
  section: DeliverySectionKey;
  curve: DeliveryCurve;           // per-30-day baseline
  kind: "count" | "median";       // count → fullAt scales with window; median → never
}
export const DELIVERY_SCALE_MAX = 120;
export const DELIVERY_MIN_EVENTS = 3;
export const DELIVERY_RUBRIC_VERSION = "delivery-v1";
export const DELIVERY_SECTION_WEIGHTS: Record<DeliverySectionKey, number>; // 0.4 / 0.3 / 0.3
export const DELIVERY_RUBRIC_V1: readonly DeliveryMetricDef[];             // 7 defs below
```

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/evaluator test delivery/rubric`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `rubric.ts`**

```ts
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
```

- [ ] **Step 4: Barrel/export wiring** — check how `packages/evaluator` exposes modules (`src/index.ts` vs package.json subpath like `./jobId`). Add `delivery/rubric` the same way the engine modules are exposed so `@caliber/evaluator` consumers (gateway Task 7) can import it. Note what you did in the report.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/evaluator test delivery/rubric`
Expected: PASS (2 tests). Also `pnpm --filter @caliber/evaluator typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/evaluator/
git commit -m "feat(evaluator): delivery rubric v1 constants (7 metrics, 3 sections, 120 scale)"
```

---

### Task 2: Metric computation (`packages/evaluator/src/delivery/metrics.ts`)

**Files:**
- Create: `packages/evaluator/src/delivery/metrics.ts`
- Test: `packages/evaluator/tests/delivery/metrics.test.ts`

**Interfaces:**
- Consumes: `DeliveryMetricKey` from Task 1.
- Produces (consumed by Tasks 3, 7):

```ts
export interface DeliveryPullInput { ghNodeId: string; authorGhId: number | null; draft: boolean; ghCreatedAt: Date; mergedAt: Date | null; }
export interface DeliveryReviewInput { reviewerGhId: number | null; prGhNodeId: string; prAuthorGhId: number | null; submittedAt: Date; }
export interface DeliveryIssueInput { assigneeGhIds: number[]; closedByGhId: number | null; ghCreatedAt: Date; closedAt: Date | null; }
export interface DeliveryProjectItemInput { assigneeGhIds: number[]; isDone: boolean; ghUpdatedAt: Date; }
export interface DeliveryWindow { start: Date; end: Date; }
export interface DeliveryMetricsResult {
  windowDays: number;                                   // max(1, round((end-start)/day))
  values: Partial<Record<DeliveryMetricKey, number>>;   // medians absent when 0 samples; counts always present
  totalEvents: number;                                  // mergedPRs + issuesClosed + reviewsSubmitted
}
export function computeDeliveryMetrics(input: {
  ghUserId: number;
  window: DeliveryWindow;
  pulls: DeliveryPullInput[];
  reviews: DeliveryReviewInput[];
  issues: DeliveryIssueInput[];
  projectItems: DeliveryProjectItemInput[];
}): DeliveryMetricsResult;
```

Semantics (each is a test case below):
- `merged_pr_count`: `authorGhId === ghUserId && !draft && mergedAt within window`.
- `pr_lead_time_hours_median`: over exactly those merged PRs, `(mergedAt - ghCreatedAt)` in hours.
- `issues_closed_count`: `closedAt within window && (closedByGhId === ghUserId || assigneeGhIds.includes(ghUserId))`.
- `issue_resolution_days_median`: over exactly those issues, `(closedAt - ghCreatedAt)` in days.
- `reviews_submitted`: `reviewerGhId === ghUserId && submittedAt within window && reviewerGhId !== prAuthorGhId` (self-review exclusion; a null prAuthorGhId is NOT a self-review).
- `distinct_prs_reviewed`: distinct `prGhNodeId` among those.
- `project_items_completed`: `isDone && ghUpdatedAt within window && assigneeGhIds.includes(ghUserId)`.
- "within window" = `start <= t && t <= end` (inclusive both ends).
- Median: sort ascending; odd → middle; even → mean of two middles.
- Pure function: no mutation of inputs, returns a new object.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/evaluator test delivery/metrics`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `metrics.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/evaluator test delivery/metrics`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/delivery/metrics.ts packages/evaluator/tests/delivery/metrics.test.ts
git commit -m "feat(evaluator): pure delivery metric computation (window, exclusions, medians)"
```

---

### Task 3: Curve scoring (`packages/evaluator/src/delivery/score.ts`)

**Files:**
- Create: `packages/evaluator/src/delivery/score.ts`
- Test: `packages/evaluator/tests/delivery/score.test.ts`

**Interfaces:**
- Consumes: `curveScore` (`../engine/continuousScorer.js` — pure linear map, inverted curves invert automatically), rubric (Task 1), `DeliveryMetricsResult` (Task 2).
- Produces (consumed by Task 7; `sections` doubles as the report's `metrics`/`sectionScores` jsonb payload):

```ts
export interface DeliveryMetricScore {
  key: DeliveryMetricKey;
  value: number | null;                 // null = absent (no samples)
  scaledCurve: DeliveryCurve;           // what was actually applied
  subscore: number | null;              // curveScore output [0,1], null when absent
}
export interface DeliverySectionScore {
  key: DeliverySectionKey;
  weight: number;
  score: number | null;                 // mean of present subscores, [0,1]; null when all absent
  metrics: DeliveryMetricScore[];
}
export interface DeliveryScoreResult {
  totalScore: number | null;            // 0..120; null when insufficientData or no scorable section
  insufficientData: boolean;            // totalEvents < DELIVERY_MIN_EVENTS
  rubricVersion: string;
  windowDays: number;
  totalEvents: number;
  sections: DeliverySectionScore[];
}
export function scoreDelivery(metrics: DeliveryMetricsResult): DeliveryScoreResult;
```

Semantics:
- Count curves scale: `fullAt × windowDays/30` (zeroAt stays 0). Median curves unscaled.
- Absent metric → `subscore: null`, excluded from the section mean.
- Section score = mean of present subscores; all-absent section → `score: null`.
- Total = `DELIVERY_SCALE_MAX × Σ(weight_s × score_s) / Σ(weight_s)` over sections with non-null score (weight renormalization, mirroring the rule engine's Σweight-of-present convention).
- `insufficientData` (totalEvents < 3) → `totalScore: null` but sections are STILL computed and returned (for the PR 4 UI to show partial evidence).
- Round `totalScore` to 1 decimal place (`Math.round(x * 10) / 10`).

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/evaluator test delivery/score`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `score.ts`**

```ts
/**
 * Delivery score assembly (spec 2026-07-15 Component 3). Pure.
 * Reuses curveScore (linear, auto-inverting). Weight renormalization
 * over scorable sections mirrors the rule engine's Σweight-of-present
 * convention; insufficient data yields null total, never zero.
 */
import { curveScore } from "../engine/continuousScorer.js";
import {
  DELIVERY_MIN_EVENTS,
  DELIVERY_RUBRIC_V1,
  DELIVERY_RUBRIC_VERSION,
  DELIVERY_SCALE_MAX,
  DELIVERY_SECTION_WEIGHTS,
  type DeliveryCurve,
  type DeliveryMetricKey,
  type DeliverySectionKey,
} from "./rubric.js";
import type { DeliveryMetricsResult } from "./metrics.js";

export interface DeliveryMetricScore {
  key: DeliveryMetricKey;
  value: number | null;
  scaledCurve: DeliveryCurve;
  subscore: number | null;
}

export interface DeliverySectionScore {
  key: DeliverySectionKey;
  weight: number;
  score: number | null;
  metrics: DeliveryMetricScore[];
}

export interface DeliveryScoreResult {
  totalScore: number | null;
  insufficientData: boolean;
  rubricVersion: string;
  windowDays: number;
  totalEvents: number;
  sections: DeliverySectionScore[];
}

const SECTION_ORDER: readonly DeliverySectionKey[] = [
  "throughput",
  "collaboration",
  "timeliness",
];

export function scoreDelivery(metrics: DeliveryMetricsResult): DeliveryScoreResult {
  const windowFactor = metrics.windowDays / 30;

  const sections: DeliverySectionScore[] = SECTION_ORDER.map((sectionKey) => {
    const defs = DELIVERY_RUBRIC_V1.filter((d) => d.section === sectionKey);
    const metricScores: DeliveryMetricScore[] = defs.map((def) => {
      const scaledCurve: DeliveryCurve =
        def.kind === "count"
          ? { zeroAt: def.curve.zeroAt, fullAt: def.curve.fullAt * windowFactor }
          : { ...def.curve };
      const raw = metrics.values[def.key];
      return {
        key: def.key,
        value: raw ?? null,
        scaledCurve,
        subscore: raw === undefined ? null : curveScore(raw, scaledCurve),
      };
    });

    const present = metricScores.filter((m) => m.subscore !== null);
    return {
      key: sectionKey,
      weight: DELIVERY_SECTION_WEIGHTS[sectionKey],
      score:
        present.length === 0
          ? null
          : present.reduce((sum, m) => sum + (m.subscore as number), 0) /
            present.length,
      metrics: metricScores,
    };
  });

  const insufficientData = metrics.totalEvents < DELIVERY_MIN_EVENTS;

  const scorable = sections.filter((s) => s.score !== null);
  const weightSum = scorable.reduce((sum, s) => sum + s.weight, 0);
  const weighted =
    weightSum > 0
      ? scorable.reduce((sum, s) => sum + s.weight * (s.score as number), 0) /
        weightSum
      : null;

  const totalScore =
    insufficientData || weighted === null
      ? null
      : Math.round(DELIVERY_SCALE_MAX * weighted * 10) / 10;

  return {
    totalScore,
    insufficientData,
    rubricVersion: DELIVERY_RUBRIC_VERSION,
    windowDays: metrics.windowDays,
    totalEvents: metrics.totalEvents,
    sections,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/evaluator test delivery` (all three delivery test files)
Expected: PASS (15 tests total). `pnpm --filter @caliber/evaluator typecheck` → exit 0.

- [ ] **Step 5: Export wiring** — expose `delivery/metrics` and `delivery/score` the same way Task 1 exposed `delivery/rubric` (barrel or subpath — match what Task 1 did).

- [ ] **Step 6: Commit**

```bash
git add packages/evaluator/
git commit -m "feat(evaluator): delivery curve scoring with window scaling and weight renormalization"
```

---

### Task 4: RBAC action `delivery.read_user`

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts` (after the `github.manage` entry)
- Modify: `packages/auth/src/rbac/check.ts` (after the `github.manage` case)
- Test: `packages/auth/tests/rbac/deliveryReadUser.test.ts`

**Interfaces:**
- Produces: `can(perm, { type: "delivery.read_user", orgId, targetUserId })` → true for self OR org_admin at that org (mirrors `report.read_user`, `check.ts:245-247`). Consumed by Task 9's `getReport`/`listActivity`.

- [ ] **Step 1: Write the failing test** — copy `makePerm` verbatim from `packages/auth/tests/rbac/githubManage.test.ts` (which copied it from byokOwnership; it builds `UserPermissions` from role rows; note `makePerm(rows, userId?)` — the second arg defaults to `"actor-1"`):

```ts
import { describe, it, expect } from "vitest";
import { can } from "../../src/rbac/check.js";
// makePerm copied verbatim from ./githubManage.test.ts

describe("delivery.read_user", () => {
  it("allows self-access regardless of role", () => {
    const perm = makePerm([{ role: "member", scopeType: "organization", scopeId: "org-1" }], "user-A");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-A" })).toBe(true);
  });

  it("allows org_admin of the same org for another user", () => {
    const perm = makePerm([{ role: "org_admin", scopeType: "organization", scopeId: "org-1" }], "admin-1");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(true);
  });

  it("denies a plain member reading another user", () => {
    const perm = makePerm([{ role: "member", scopeType: "organization", scopeId: "org-1" }], "user-A");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(false);
  });

  it("denies org_admin of a different org", () => {
    const perm = makePerm([{ role: "org_admin", scopeType: "organization", scopeId: "org-2" }], "admin-1");
    expect(can(perm, { type: "delivery.read_user", orgId: "org-1", targetUserId: "user-B" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/auth test deliveryReadUser`
Expected: FAIL — unknown action type.

- [ ] **Step 3: Add the union member** in `actions.ts` (after `github.manage`):

```ts
  | { type: "delivery.read_user"; orgId: string; targetUserId: string }
```

- [ ] **Step 4: Add the case** in `check.ts` (after the `github.manage` case; body mirrors `report.read_user` at check.ts:245-247):

```ts
    case "delivery.read_user":
      if (action.targetUserId === perm.userId) return true;
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
```

- [ ] **Step 5: Run to verify green**

Run: `pnpm --filter @caliber/auth test deliveryReadUser && pnpm --filter @caliber/auth typecheck`
Expected: PASS (4 tests); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/
git commit -m "feat(auth): delivery.read_user RBAC action (self or org_admin)"
```

---

### Task 5: `github-delivery` queue module

**Files:**
- Create: `apps/gateway/src/workers/githubDelivery/queue.ts`
- Test: `apps/gateway/tests/workers/githubDeliveryQueue.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 8-9):
  - `GITHUB_DELIVERY_QUEUE_NAME = "github-delivery"`, `GITHUB_DELIVERY_QUEUE_PREFIX = "caliber:gw"`, `GITHUB_DELIVERY_JOB_NAME = "github-delivery"`, `GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS` (same values as github-sync)
  - `GithubDeliveryJobPayload` (zod): `{ orgId: uuid, userId: uuid, periodStart: ISO datetime string, periodEnd: ISO datetime string, periodType: "daily", triggeredBy: "cron" | "manual" }`
  - `buildGithubDeliveryJobId({ orgId, userId, periodStart }): string`
  - `QueueLike` (same optional-`remove` shape as github-sync — import it: `import type { QueueLike } from "../githubSync/queue.js";`)
  - `createGithubDeliveryQueue(opts)` (same shape as `createGithubSyncQueue`)
  - `enqueueGithubDelivery(queue, payload, opts?: { regenerate?: boolean })` — **remove-before-add ONLY when `regenerate: true`** (manual generate); plain add otherwise (cron relies on time-bucketed dedup — see Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  GITHUB_DELIVERY_JOB_NAME,
  GithubDeliveryJobPayload,
  buildGithubDeliveryJobId,
  enqueueGithubDelivery,
} from "../../src/workers/githubDelivery/queue.js";
import type { QueueLike } from "../../src/workers/githubSync/queue.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";
const USER = "0b7e7d1e-0000-4000-8000-000000000002";
const PAYLOAD = {
  orgId: ORG, userId: USER,
  periodStart: "2026-06-16T00:00:00.000Z", periodEnd: "2026-07-16T00:00:00.000Z",
  periodType: "daily" as const, triggeredBy: "manual" as const,
};

describe("buildGithubDeliveryJobId", () => {
  it("is deterministic, colon-free, and time-bucketed", () => {
    const id = buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: PAYLOAD.periodStart });
    expect(id).toBe(buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: PAYLOAD.periodStart }));
    expect(id).not.toContain(":");
    expect(id).toContain(USER);
    // different window → different id (no cross-window dedup)
    expect(buildGithubDeliveryJobId({ orgId: ORG, userId: USER, periodStart: "2026-06-17T00:00:00.000Z" })).not.toBe(id);
  });
});

describe("enqueueGithubDelivery", () => {
  it("plain add without regenerate (cron path — no remove)", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    const queue: QueueLike = { add, remove };
    const { jobId } = await enqueueGithubDelivery(queue, PAYLOAD);
    expect(remove).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(GITHUB_DELIVERY_JOB_NAME, PAYLOAD, { jobId });
  });

  it("remove-before-add with regenerate: true (manual path)", async () => {
    const calls: string[] = [];
    const queue: QueueLike = {
      add: vi.fn(async () => void calls.push("add")),
      remove: vi.fn(async () => void calls.push("remove")),
    };
    await enqueueGithubDelivery(queue, PAYLOAD, { regenerate: true });
    expect(calls).toEqual(["remove", "add"]);
  });

  it("regenerate works when the queue has no remove method, and remove failure never blocks add", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await enqueueGithubDelivery({ add }, PAYLOAD, { regenerate: true });
    expect(add).toHaveBeenCalledTimes(1);
    const failingRemove: QueueLike = { add, remove: vi.fn().mockRejectedValue(new Error("boom")) };
    await enqueueGithubDelivery(failingRemove, PAYLOAD, { regenerate: true });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid payloads (bad uuid, bad triggeredBy)", async () => {
    const queue: QueueLike = { add: vi.fn() };
    await expect(enqueueGithubDelivery(queue, { ...PAYLOAD, orgId: "nope" })).rejects.toThrow();
    expect(GithubDeliveryJobPayload.safeParse({ ...PAYLOAD, triggeredBy: "interval" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @caliber/gateway test githubDeliveryQueue`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `queue.ts`** (mirror `githubSync/queue.ts` including the remove-before-add comment explaining the BullMQ completed-hash dedup; the ONLY structural difference is the `regenerate` option):

```ts
/**
 * github-delivery queue (PR2, spec 2026-07-15 Component 3). One job per
 * (org, user, window). jobIds are time-bucketed (periodStart embedded) so
 * distinct windows never dedup against each other. Manual regeneration
 * removes the stale completed/failed hash first (BullMQ 5 dedups adds
 * against finished jobs; Queue#remove no-ops on active jobs, so an
 * in-flight computation still dedups). The cron path adds plainly —
 * same-Monday repeats are MEANT to dedup against the completed hash.
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import type { Redis, RedisOptions } from "ioredis";
import type { QueueLike } from "../githubSync/queue.js";

export const GITHUB_DELIVERY_QUEUE_NAME = "github-delivery";
export const GITHUB_DELIVERY_QUEUE_PREFIX = "caliber:gw";
export const GITHUB_DELIVERY_JOB_NAME = "github-delivery";

export const GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 500 },
  removeOnFail: { age: 7 * 86400 },
} as const satisfies JobsOptions;

export const GithubDeliveryJobPayload = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  periodType: z.literal("daily"),
  triggeredBy: z.enum(["cron", "manual"]),
});
export type GithubDeliveryJobPayload = z.infer<typeof GithubDeliveryJobPayload>;

/** Colon-free (BullMQ rejects ':') and time-bucketed (PR1 C1 lesson). */
export function buildGithubDeliveryJobId(input: {
  orgId: string;
  userId: string;
  periodStart: string;
}): string {
  return ["ghdel", "v1", input.orgId, input.userId, input.periodStart]
    .join("_")
    .replaceAll(":", "-");
}

export interface CreateGithubDeliveryQueueOptions {
  connection: Redis | RedisOptions;
  prefix?: string;
  defaultJobOptions?: JobsOptions;
}

export function createGithubDeliveryQueue(
  opts: CreateGithubDeliveryQueueOptions,
): Queue<GithubDeliveryJobPayload> {
  return new Queue<GithubDeliveryJobPayload>(GITHUB_DELIVERY_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? GITHUB_DELIVERY_QUEUE_PREFIX,
    defaultJobOptions: {
      ...GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS,
      backoff: { ...GITHUB_DELIVERY_DEFAULT_JOB_OPTIONS.backoff },
      ...opts.defaultJobOptions,
    },
  });
}

export async function enqueueGithubDelivery(
  queue: QueueLike,
  payload: unknown,
  opts?: { regenerate?: boolean },
): Promise<{ jobId: string }> {
  const validated = GithubDeliveryJobPayload.parse(payload);
  const jobId = buildGithubDeliveryJobId(validated);
  if (opts?.regenerate) {
    try {
      await queue.remove?.(jobId);
    } catch {
      // Removal is best-effort; never block the add.
    }
  }
  await queue.add(GITHUB_DELIVERY_JOB_NAME, validated, { jobId });
  return { jobId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @caliber/gateway test githubDeliveryQueue`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubDelivery/queue.ts apps/gateway/tests/workers/githubDeliveryQueue.test.ts
git commit -m "feat(gateway): github-delivery queue module (time-bucketed jobId, regenerate remove-before-add)"
```

---

### Task 6: Attribution + activity fetch (`fetchActivity.ts`)

**Files:**
- Create: `apps/gateway/src/workers/githubDelivery/fetchActivity.ts`
- Test: `apps/gateway/tests/workers/githubDelivery/fetchActivity.integration.test.ts`

**Interfaces:**
- Consumes: `accounts` (`@caliber/db`; composite PK `(provider, providerAccountId)`, `providerAccountId` is TEXT), activity tables, metric input types from Task 2.
- Produces (consumed by Task 7):

```ts
export async function resolveGithubUserId(db: Database, userId: string): Promise<number | null>;
// accounts row where provider='github' and userId matches → Number(providerAccountId);
// missing row or non-finite parse → null.

export interface DeliveryActivity {
  pulls: DeliveryPullInput[];
  reviews: DeliveryReviewInput[];
  issues: DeliveryIssueInput[];
  projectItems: DeliveryProjectItemInput[];
}
export async function fetchDeliveryActivity(
  db: Database,
  input: { orgId: string; ghUserId: number; window: { start: Date; end: Date } },
): Promise<DeliveryActivity>;
```

Query strategy (lock it — team-scale pragmatism, documented in the file header):
- **pulls**: SQL narrows by `orgId` + `authorGhId = ghUserId` + `mergedAt` between start/end (indexed org_author/org_merged); map to `DeliveryPullInput`.
- **reviews**: SQL joins `githubReviews` ⨝ `githubPullRequests` on `(orgId, prGhNodeId = ghNodeId)` selecting reviewer/prAuthor, narrowed by `reviewerGhId = ghUserId` + `submittedAt` in window. Left-join semantics: a review whose PR row is missing gets `prAuthorGhId: null` (still counts — spec's ghost rule).
- **issues**: SQL narrows by `orgId` + `closedAt` in window ONLY (jsonb assignee membership + closedBy OR-match happens in `computeDeliveryMetrics` — pure TS, already tested; avoids jsonb-containment SQL).
- **projectItems**: SQL narrows by `orgId` + `isDone = true` + `ghUpdatedAt` in window; assignee filter in TS.
- `assigneeGhIds` jsonb → validate to `number[]` with a tiny guard (`Array.isArray` + `filter(Number.isFinite)`) — never trust the cast.

- [ ] **Step 1: Write the failing integration test** (container boilerplate + `insertOrg` copied from `apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts`; also insert a `users` row + `accounts` row — `users` needs only `email`/`name`, `accounts` needs `userId`/`type: "oauth"`/`provider: "github"`/`providerAccountId`):

```ts
import { accounts, users, githubPullRequests, githubReviews, githubIssues, githubProjectItems } from "@caliber/db";
import { resolveGithubUserId, fetchDeliveryActivity } from "../../../src/workers/githubDelivery/fetchActivity.js";

const WINDOW = { start: new Date("2026-06-16T00:00:00Z"), end: new Date("2026-07-16T00:00:00Z") };

async function insertMember(db, ghId: number) {
  const [u] = await db.insert(users).values({ email: `m${ghId}-${Math.random().toString(36).slice(2)}@t.test`, name: "m" }).returning();
  await db.insert(accounts).values({ userId: u!.id, type: "oauth", provider: "github", providerAccountId: String(ghId) });
  return u!;
}

it("resolveGithubUserId maps the github account row; null when absent or non-numeric", async () => {
  const u = await insertMember(db, 777);
  expect(await resolveGithubUserId(db, u.id)).toBe(777);
  const [noGh] = await db.insert(users).values({ email: `x-${Math.random().toString(36).slice(2)}@t.test`, name: "x" }).returning();
  expect(await resolveGithubUserId(db, noGh!.id)).toBeNull();
  const [badGh] = await db.insert(users).values({ email: `y-${Math.random().toString(36).slice(2)}@t.test`, name: "y" }).returning();
  await db.insert(accounts).values({ userId: badGh!.id, type: "oauth", provider: "github", providerAccountId: "not-a-number" });
  expect(await resolveGithubUserId(db, badGh!.id)).toBeNull();
});

it("fetchDeliveryActivity narrows by org/window/author and joins review→PR author", async () => {
  const org = await insertOrg(db);
  const otherOrg = await insertOrg(db);
  const base = { orgId: org.id, repoFullName: "acme/web", state: "closed", title: "t", htmlUrl: "u", baseRef: "main", ghCreatedAt: new Date("2026-07-01T00:00:00Z") };

  await db.insert(githubPullRequests).values([
    { ...base, number: 1, ghNodeId: "PR_1", authorGhId: 777, authorLogin: "me", mergedAt: new Date("2026-07-02T00:00:00Z") },
    { ...base, number: 2, ghNodeId: "PR_2", authorGhId: 999, authorLogin: "other", mergedAt: new Date("2026-07-02T00:00:00Z") }, // other author → excluded by SQL
    { ...base, number: 3, ghNodeId: "PR_3", authorGhId: 777, authorLogin: "me", mergedAt: new Date("2026-05-01T00:00:00Z") },   // out of window
    { ...base, orgId: otherOrg.id, number: 4, ghNodeId: "PR_4", authorGhId: 777, authorLogin: "me", mergedAt: new Date("2026-07-02T00:00:00Z") }, // other org
  ]);
  await db.insert(githubReviews).values([
    { orgId: org.id, repoFullName: "acme/web", ghNodeId: "R_1", prGhNodeId: "PR_2", reviewerGhId: 777, reviewerLogin: "me", state: "APPROVED", submittedAt: new Date("2026-07-03T00:00:00Z") },
    { orgId: org.id, repoFullName: "acme/web", ghNodeId: "R_2", prGhNodeId: "PR_MISSING", reviewerGhId: 777, reviewerLogin: "me", state: "APPROVED", submittedAt: new Date("2026-07-03T00:00:00Z") }, // PR row absent → prAuthorGhId null
  ]);
  await db.insert(githubIssues).values([
    { orgId: org.id, repoFullName: "acme/web", number: 7, ghNodeId: "I_7", assigneeGhIds: [777], state: "closed", title: "i", htmlUrl: "u", ghCreatedAt: new Date("2026-06-30T00:00:00Z"), closedAt: new Date("2026-07-02T00:00:00Z") },
    { orgId: org.id, repoFullName: "acme/web", number: 8, ghNodeId: "I_8", assigneeGhIds: "garbage" as never, state: "closed", title: "i", htmlUrl: "u", ghCreatedAt: new Date("2026-06-30T00:00:00Z"), closedAt: new Date("2026-07-02T00:00:00Z") }, // malformed jsonb → sanitized to []
  ]);
  await db.insert(githubProjectItems).values([
    { orgId: org.id, projectNodeId: "PVT_1", projectTitle: "Q3", itemNodeId: "PVTI_1", contentType: "ISSUE", assigneeGhIds: [777], statusValue: "Done", isDone: true, ghUpdatedAt: new Date("2026-07-05T00:00:00Z") },
    { orgId: org.id, projectNodeId: "PVT_1", projectTitle: "Q3", itemNodeId: "PVTI_2", contentType: "ISSUE", assigneeGhIds: [777], statusValue: "Todo", isDone: false, ghUpdatedAt: new Date("2026-07-05T00:00:00Z") }, // not done → excluded by SQL
  ]);

  const a = await fetchDeliveryActivity(db, { orgId: org.id, ghUserId: 777, window: WINDOW });
  expect(a.pulls.map((p) => p.ghNodeId)).toEqual(["PR_1"]);
  expect(a.reviews).toHaveLength(2);
  expect(a.reviews.find((r) => r.prGhNodeId === "PR_2")!.prAuthorGhId).toBe(999);
  expect(a.reviews.find((r) => r.prGhNodeId === "PR_MISSING")!.prAuthorGhId).toBeNull();
  expect(a.issues).toHaveLength(2);
  expect(a.issues.find((i) => i.assigneeGhIds.length === 0)).toBeDefined(); // sanitized garbage
  expect(a.projectItems).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration githubDelivery/fetchActivity`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `fetchActivity.ts`**

```ts
/**
 * Attribution + activity fetch for delivery scoring (PR2).
 * SQL narrows by org/window/indexed author columns; jsonb assignee
 * membership and closedBy-OR-assignee logic stay in the pure metric
 * layer (already unit-tested there). assigneeGhIds jsonb is sanitized —
 * never trusted as number[].
 */
import { and, eq, gte, lte, isNotNull } from "drizzle-orm";
import {
  accounts,
  githubIssues,
  githubProjectItems,
  githubPullRequests,
  githubReviews,
} from "@caliber/db";
import type { Database } from "@caliber/db";
import type {
  DeliveryIssueInput,
  DeliveryProjectItemInput,
  DeliveryPullInput,
  DeliveryReviewInput,
} from "@caliber/evaluator";

export async function resolveGithubUserId(
  db: Database,
  userId: string,
): Promise<number | null> {
  const row = (
    await db
      .select({ providerAccountId: accounts.providerAccountId })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "github")))
      .limit(1)
  )[0];
  if (!row) return null;
  const ghId = Number(row.providerAccountId);
  return Number.isFinite(ghId) ? ghId : null;
}

function sanitizeGhIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];
}

export interface DeliveryActivity {
  pulls: DeliveryPullInput[];
  reviews: DeliveryReviewInput[];
  issues: DeliveryIssueInput[];
  projectItems: DeliveryProjectItemInput[];
}

export async function fetchDeliveryActivity(
  db: Database,
  input: { orgId: string; ghUserId: number; window: { start: Date; end: Date } },
): Promise<DeliveryActivity> {
  const { orgId, ghUserId, window } = input;

  const pullRows = await db
    .select({
      ghNodeId: githubPullRequests.ghNodeId,
      authorGhId: githubPullRequests.authorGhId,
      draft: githubPullRequests.draft,
      ghCreatedAt: githubPullRequests.ghCreatedAt,
      mergedAt: githubPullRequests.mergedAt,
    })
    .from(githubPullRequests)
    .where(
      and(
        eq(githubPullRequests.orgId, orgId),
        eq(githubPullRequests.authorGhId, ghUserId),
        isNotNull(githubPullRequests.mergedAt),
        gte(githubPullRequests.mergedAt, window.start),
        lte(githubPullRequests.mergedAt, window.end),
      ),
    );

  const reviewRows = await db
    .select({
      reviewerGhId: githubReviews.reviewerGhId,
      prGhNodeId: githubReviews.prGhNodeId,
      submittedAt: githubReviews.submittedAt,
      prAuthorGhId: githubPullRequests.authorGhId,
    })
    .from(githubReviews)
    .leftJoin(
      githubPullRequests,
      and(
        eq(githubPullRequests.orgId, githubReviews.orgId),
        eq(githubPullRequests.ghNodeId, githubReviews.prGhNodeId),
      ),
    )
    .where(
      and(
        eq(githubReviews.orgId, orgId),
        eq(githubReviews.reviewerGhId, ghUserId),
        gte(githubReviews.submittedAt, window.start),
        lte(githubReviews.submittedAt, window.end),
      ),
    );

  const issueRows = await db
    .select({
      assigneeGhIds: githubIssues.assigneeGhIds,
      closedByGhId: githubIssues.closedByGhId,
      ghCreatedAt: githubIssues.ghCreatedAt,
      closedAt: githubIssues.closedAt,
    })
    .from(githubIssues)
    .where(
      and(
        eq(githubIssues.orgId, orgId),
        isNotNull(githubIssues.closedAt),
        gte(githubIssues.closedAt, window.start),
        lte(githubIssues.closedAt, window.end),
      ),
    );

  const itemRows = await db
    .select({
      assigneeGhIds: githubProjectItems.assigneeGhIds,
      isDone: githubProjectItems.isDone,
      ghUpdatedAt: githubProjectItems.ghUpdatedAt,
    })
    .from(githubProjectItems)
    .where(
      and(
        eq(githubProjectItems.orgId, orgId),
        eq(githubProjectItems.isDone, true),
        gte(githubProjectItems.ghUpdatedAt, window.start),
        lte(githubProjectItems.ghUpdatedAt, window.end),
      ),
    );

  return {
    pulls: pullRows.map((r) => ({
      ghNodeId: r.ghNodeId,
      authorGhId: r.authorGhId,
      draft: r.draft,
      ghCreatedAt: r.ghCreatedAt,
      mergedAt: r.mergedAt,
    })),
    reviews: reviewRows.map((r) => ({
      reviewerGhId: r.reviewerGhId,
      prGhNodeId: r.prGhNodeId,
      prAuthorGhId: r.prAuthorGhId ?? null,
      submittedAt: r.submittedAt,
    })),
    issues: issueRows.map((r) => ({
      assigneeGhIds: sanitizeGhIds(r.assigneeGhIds),
      closedByGhId: r.closedByGhId,
      ghCreatedAt: r.ghCreatedAt,
      closedAt: r.closedAt,
    })),
    projectItems: itemRows.map((r) => ({
      assigneeGhIds: sanitizeGhIds(r.assigneeGhIds),
      isDone: r.isDone,
      ghUpdatedAt: r.ghUpdatedAt,
    })),
  };
}
```

(If Task 1/3's export wiring made these types available under a subpath instead of the root `@caliber/evaluator`, adjust the type import accordingly — note it in the report.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration githubDelivery/fetchActivity && pnpm --filter @caliber/gateway typecheck`
Expected: PASS (2 tests); typecheck exit 0 (may need `pnpm --filter @caliber/evaluator build` first — Turbo dep).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubDelivery/fetchActivity.ts apps/gateway/tests/workers/githubDelivery/
git commit -m "feat(gateway): delivery attribution resolve + org/window activity fetch"
```

---

### Task 7: `runDeliveryEval` (staleness-gated sync → metrics → score → upsert)

**Files:**
- Create: `apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts`
- Test: `apps/gateway/tests/workers/githubDelivery/runDeliveryEval.integration.test.ts`

**Interfaces:**
- Consumes: `syncOrg` (`../githubSync/syncOrg.js`), `resolveGithubUserId`/`fetchDeliveryActivity` (Task 6), `computeDeliveryMetrics`/`scoreDelivery` (Tasks 2-3), `githubConnections` + `githubDeliveryReports` tables, `GithubDeliveryJobPayload` (Task 5).
- Produces (consumed by Task 8's worker):

```ts
export const SYNC_STALE_AFTER_MS = 60 * 60 * 1000; // spec: chain a sync when older than 1h
export interface RunDeliveryEvalResult {
  reportId: string | null;
  skippedSync: boolean;                 // true when lastSyncAt was fresh
  noIdentity: boolean;                  // member had no github account row
}
export async function runDeliveryEval(input: {
  db: Database;
  masterKeyHex: string;
  payload: GithubDeliveryJobPayload;
  fetchImpl?: typeof fetch;             // threaded to syncOrg (test seam)
  now?: Date;                           // staleness clock (test seam; default new Date())
}): Promise<RunDeliveryEvalResult>;
```

Flow (each branch is a test):
1. Load the org's `githubConnections` row. If present AND `deliveryEnabled` AND (`lastSyncAt` null OR older than `SYNC_STALE_AFTER_MS` vs `now`) → `await syncOrg({ db, masterKeyHex, orgId, fetchImpl })` first (inline — single job, no cross-queue coordination). A sync failure is NOT fatal: catch, log nothing sensitive, proceed to score whatever data exists (report still gets written). No connection row → skip sync, still score from existing tables.
2. `resolveGithubUserId` → null → upsert a report row with `totalScore: null`, `insufficientData: true`, `sectionScores: []`, `metrics: { noIdentity: true }`, `llmStatus: "skipped"` → return `{ noIdentity: true }`.
3. Otherwise `fetchDeliveryActivity` → `computeDeliveryMetrics` → `scoreDelivery`.
4. Upsert into `githubDeliveryReports` with `onConflictDoUpdate` target `[orgId, userId, periodStart, periodType]`, set: `periodEnd`, `totalScore` (as string via `.toString()` — decimal column — or null), `insufficientData`, `sectionScores` (the `sections` array), `metrics` (`{ windowDays, totalEvents, values, rubricVersion }`), `llmStatus: "skipped"`, `triggeredBy`, `updatedAt: new Date()`. Return the row id via `.returning({ id })`.

- [ ] **Step 1: Write the failing integration test** (boilerplate + `insertOrg`/`insertConnection`/`routeFetch`/`json`/`PULL_DETAIL`/`MASTER_KEY` from `apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts`; `insertMember` from Task 6's test):

```ts
import { githubDeliveryReports, githubPullRequests } from "@caliber/db";
import { runDeliveryEval, SYNC_STALE_AFTER_MS } from "../../../src/workers/githubDelivery/runDeliveryEval.js";

const NOW = new Date("2026-07-16T12:00:00Z");
const payload = (orgId: string, userId: string) => ({
  orgId, userId,
  periodStart: "2026-06-16T00:00:00.000Z", periodEnd: "2026-07-16T00:00:00.000Z",
  periodType: "daily" as const, triggeredBy: "manual" as const,
});

it("fresh sync is skipped; report upserted from existing activity rows", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id, { lastSyncAt: new Date(NOW.getTime() - 10 * 60 * 1000) }); // 10min ago
  const member = await insertMember(db, 777);
  // seed one merged PR + reviews/issues to clear DELIVERY_MIN_EVENTS=3
  // (insert directly into githubPullRequests/githubReviews/githubIssues — same shapes as Task 6's test)
  const res = await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: payload(org.id, member.id), now: NOW });
  expect(res.skippedSync).toBe(true);
  expect(res.noIdentity).toBe(false);
  const report = (await db.select().from(githubDeliveryReports)).find((r) => r.userId === member.id)!;
  expect(report.llmStatus).toBe("skipped");
  expect(report.insufficientData).toBe(false);
  expect(Number(report.totalScore)).toBeGreaterThan(0);
  expect(report.periodType).toBe("daily");
});

it("stale lastSyncAt triggers an inline sync first (fetch hits GitHub), then scores", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id, { lastSyncAt: new Date(NOW.getTime() - SYNC_STALE_AFTER_MS - 1000) });
  const member = await insertMember(db, 777);
  const fetchImpl = routeFetch({ /* same happy-path routes as syncOrg's test: repos → one PR_1 authored by 777, merged in window; empty issues; empty projects */ });
  const res = await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: payload(org.id, member.id), fetchImpl, now: NOW });
  expect(res.skippedSync).toBe(false);
  // the PR synced inline is what got scored
  expect((await db.select().from(githubPullRequests)).filter((p) => p.orgId === org.id)).toHaveLength(1);
  const report = (await db.select().from(githubDeliveryReports)).find((r) => r.userId === member.id)!;
  expect(report.insufficientData).toBe(true); // only 1 event < 3
  expect(report.totalScore).toBeNull();
});

it("member without a github account → noIdentity report, never an error", async () => {
  const org = await insertOrg(db);
  const [plain] = await db.insert(users).values({ email: `p-${Math.random().toString(36).slice(2)}@t.test`, name: "p" }).returning();
  const res = await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: payload(org.id, plain!.id), now: NOW });
  expect(res.noIdentity).toBe(true);
  const report = (await db.select().from(githubDeliveryReports)).find((r) => r.userId === plain!.id)!;
  expect(report.insufficientData).toBe(true);
  expect(report.metrics).toMatchObject({ noIdentity: true });
});

it("re-run upserts (no duplicate row) and refreshes the score", async () => {
  const org = await insertOrg(db);
  const member = await insertMember(db, 777);
  const p = payload(org.id, member.id);
  await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: p, now: NOW });
  await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: p, now: NOW });
  const rows = (await db.select().from(githubDeliveryReports)).filter((r) => r.userId === member.id);
  expect(rows).toHaveLength(1);
});
```

(Complete the seeded-rows comment in test 1 with real inserts — 1 merged PR authored by 777 + 2 reviews by 777 on someone else's PRs, so `totalEvents = 3`. Use the Task 6 test's insert shapes. `insertConnection` from syncOrg's test accepts overrides — pass `lastSyncAt`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/gateway test:integration githubDelivery/runDeliveryEval`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `runDeliveryEval.ts`**

```ts
/**
 * One delivery evaluation (PR2, spec Component 3): staleness-gated inline
 * sync → attribution → pure metrics/score → report upsert. Sync failures
 * degrade to scoring existing data (the report always lands). llm_status
 * is 'skipped' until PR3 adds the quality layer.
 */
import { and, eq } from "drizzle-orm";
import { githubConnections, githubDeliveryReports } from "@caliber/db";
import type { Database } from "@caliber/db";
import { computeDeliveryMetrics, scoreDelivery } from "@caliber/evaluator";
import { syncOrg } from "../githubSync/syncOrg.js";
import { fetchDeliveryActivity, resolveGithubUserId } from "./fetchActivity.js";
import type { GithubDeliveryJobPayload } from "./queue.js";

export const SYNC_STALE_AFTER_MS = 60 * 60 * 1000;

export interface RunDeliveryEvalResult {
  reportId: string | null;
  skippedSync: boolean;
  noIdentity: boolean;
}

export async function runDeliveryEval(input: {
  db: Database;
  masterKeyHex: string;
  payload: GithubDeliveryJobPayload;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<RunDeliveryEvalResult> {
  const { db, payload } = input;
  const now = input.now ?? new Date();
  const window = {
    start: new Date(payload.periodStart),
    end: new Date(payload.periodEnd),
  };

  const conn = (
    await db
      .select({
        deliveryEnabled: githubConnections.deliveryEnabled,
        lastSyncAt: githubConnections.lastSyncAt,
      })
      .from(githubConnections)
      .where(eq(githubConnections.orgId, payload.orgId))
      .limit(1)
  )[0];

  const syncNeeded =
    conn !== undefined &&
    conn.deliveryEnabled &&
    (conn.lastSyncAt === null ||
      now.getTime() - conn.lastSyncAt.getTime() > SYNC_STALE_AFTER_MS);

  if (syncNeeded) {
    try {
      await syncOrg({
        db,
        masterKeyHex: input.masterKeyHex,
        orgId: payload.orgId,
        fetchImpl: input.fetchImpl,
      });
    } catch {
      // Sync is best-effort here; score whatever data exists.
    }
  }

  const ghUserId = await resolveGithubUserId(db, payload.userId);

  const upsert = async (fields: {
    totalScore: string | null;
    insufficientData: boolean;
    sectionScores: unknown;
    metrics: unknown;
  }): Promise<string | null> => {
    const [row] = await db
      .insert(githubDeliveryReports)
      .values({
        orgId: payload.orgId,
        userId: payload.userId,
        periodStart: window.start,
        periodEnd: window.end,
        periodType: payload.periodType,
        totalScore: fields.totalScore,
        insufficientData: fields.insufficientData,
        sectionScores: fields.sectionScores,
        metrics: fields.metrics,
        llmStatus: "skipped",
        triggeredBy: payload.triggeredBy,
      })
      .onConflictDoUpdate({
        target: [
          githubDeliveryReports.orgId,
          githubDeliveryReports.userId,
          githubDeliveryReports.periodStart,
          githubDeliveryReports.periodType,
        ],
        set: {
          periodEnd: window.end,
          totalScore: fields.totalScore,
          insufficientData: fields.insufficientData,
          sectionScores: fields.sectionScores,
          metrics: fields.metrics,
          llmStatus: "skipped",
          triggeredBy: payload.triggeredBy,
          updatedAt: new Date(),
        },
      })
      .returning({ id: githubDeliveryReports.id });
    return row?.id ?? null;
  };

  if (ghUserId === null) {
    const reportId = await upsert({
      totalScore: null,
      insufficientData: true,
      sectionScores: [],
      metrics: { noIdentity: true },
    });
    return { reportId, skippedSync: !syncNeeded, noIdentity: true };
  }

  const activity = await fetchDeliveryActivity(db, {
    orgId: payload.orgId,
    ghUserId,
    window,
  });
  const metrics = computeDeliveryMetrics({ ghUserId, window, ...activity });
  const score = scoreDelivery(metrics);

  const reportId = await upsert({
    totalScore: score.totalScore === null ? null : score.totalScore.toString(),
    insufficientData: score.insufficientData,
    sectionScores: score.sections,
    metrics: {
      windowDays: score.windowDays,
      totalEvents: score.totalEvents,
      values: metrics.values,
      rubricVersion: score.rubricVersion,
    },
  });
  return { reportId, skippedSync: !syncNeeded, noIdentity: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @caliber/gateway test:integration githubDelivery/runDeliveryEval`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts apps/gateway/tests/workers/githubDelivery/runDeliveryEval.integration.test.ts
git commit -m "feat(gateway): runDeliveryEval — staleness-gated sync, attribution, score, report upsert"
```

---

### Task 8: Delivery worker + weekly cron + gateway wiring

**Files:**
- Create: `apps/gateway/src/workers/githubDelivery/worker.ts`
- Create: `apps/gateway/src/workers/githubDelivery/weeklyCron.ts`
- Modify: `apps/gateway/src/server.ts` (extend `wireGithubSyncPipeline`)
- Test: `apps/gateway/tests/workers/githubDelivery/weeklyCron.integration.test.ts`
- Test: `apps/gateway/tests/workers/githubDelivery/worker.integration.test.ts`

**Interfaces:**
- Consumes: delivery queue module (Task 5), `runDeliveryEval` (Task 7), `githubConnections`/`organizationMembers`/`accounts`/`organizations` tables, the coalescing interval pattern from `../githubSync/interval.ts` (the POST-C1-fix version on this branch — copy its `scheduleTick`/epoch-guard shape).
- Produces:
  - `createGithubDeliveryWorker({ connection, db, masterKeyHex, concurrency?, fetchImpl? }): Worker<GithubDeliveryJobPayload, void>` (concurrency default 1)
  - `shouldRunWeeklyDelivery(now: Date): boolean` — Monday 03:xx **UTC** (deliberate spec refinement: spec said "server time"; we align to the evaluator cron's UTC convention, `EVALUATOR_CRON_HOUR_UTC` precedent — document this in the file header)
  - `startGithubDeliveryCron({ db, queue, logger, intervalMs? /* default 1h */, clock? /* () => Date, test seam */ }): { stop(): void; tick(): Promise<void> }`

Weekly cron semantics (each a test):
- Hourly tick; fires only when `shouldRunWeeklyDelivery(clock())` — one real firing per Monday (hour 03 UTC); a second tick in the same hour produces identical day-aligned jobIds that dedup against completed hashes (deliberate — plain add, no regenerate).
- Members = orgs with `deliveryEnabled` connections on non-deleted organizations ⨝ `organizationMembers` ⨝ `accounts` where `provider = 'github'` (spec: "every attributed member" — members without a github account are NOT enqueued by cron; their no-identity reports only materialize via manual generate).
- Window: `periodEnd = startOfUTCDay(now)`, `periodStart = periodEnd - 30 days` (day-aligned → stable jobIds all Monday). `periodType: "daily"`, `triggeredBy: "cron"`.

- [ ] **Step 1: Write the failing cron test** (PG container + fake queue; boilerplate/`insertOrg`/`insertConnection` from syncOrg's test; `insertMember` from Task 6's test; also insert `organizationMembers` rows — `{ orgId, userId }`):

```ts
import { organizationMembers } from "@caliber/db";
import {
  shouldRunWeeklyDelivery,
  startGithubDeliveryCron,
} from "../../../src/workers/githubDelivery/weeklyCron.js";
import { buildGithubDeliveryJobId } from "../../../src/workers/githubDelivery/queue.js";

const MONDAY_03 = new Date("2026-07-20T03:15:00Z"); // 2026-07-20 is a Monday
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

it("shouldRunWeeklyDelivery: Monday 03 UTC only", () => {
  expect(shouldRunWeeklyDelivery(MONDAY_03)).toBe(true);
  expect(shouldRunWeeklyDelivery(new Date("2026-07-20T04:00:00Z"))).toBe(false); // Monday 04
  expect(shouldRunWeeklyDelivery(new Date("2026-07-21T03:00:00Z"))).toBe(false); // Tuesday 03
});

it("tick enqueues day-aligned rolling-30d jobs for attributed members of enabled connections only", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id);
  const withGh = await insertMember(db, 777);
  const [noGh] = await db.insert(users).values({ email: `n-${Math.random().toString(36).slice(2)}@t.test`, name: "n" }).returning();
  await db.insert(organizationMembers).values([
    { orgId: org.id, userId: withGh.id },
    { orgId: org.id, userId: noGh!.id },
  ]);
  const disabledOrg = await insertOrg(db);
  await insertConnection(db, disabledOrg.id, { deliveryEnabled: false });
  const dm = await insertMember(db, 888);
  await db.insert(organizationMembers).values({ orgId: disabledOrg.id, userId: dm.id });

  const added: Array<{ data: Record<string, unknown>; opts?: { jobId?: string } }> = [];
  const queue = { add: async (_n: string, data: unknown, opts?: { jobId?: string }) => void added.push({ data: data as Record<string, unknown>, opts }) };

  const handle = startGithubDeliveryCron({ db, queue, logger: noopLogger, clock: () => MONDAY_03 });
  added.length = 0;           // discard the start-time tick
  await handle.tick();
  handle.stop();              // stop AFTER tick (PR1 interval lesson)

  expect(added).toHaveLength(1); // only the attributed member of the enabled org
  const p = added[0]!.data;
  expect(p.userId).toBe(withGh.id);
  expect(p.triggeredBy).toBe("cron");
  expect(p.periodEnd).toBe("2026-07-20T00:00:00.000Z");
  expect(p.periodStart).toBe("2026-06-20T00:00:00.000Z");
  expect(added[0]!.opts?.jobId).toBe(
    buildGithubDeliveryJobId({ orgId: org.id, userId: withGh.id, periodStart: p.periodStart as string }),
  );
});

it("tick is a no-op outside the Monday-03 window", async () => {
  const added: unknown[] = [];
  const queue = { add: async (...a: unknown[]) => void added.push(a) };
  const handle = startGithubDeliveryCron({ db, queue, logger: noopLogger, clock: () => new Date("2026-07-21T03:00:00Z") });
  added.length = 0;
  await handle.tick();
  handle.stop();
  expect(added).toHaveLength(0);
});
```

- [ ] **Step 2: Write the failing worker e2e test** (PG + Redis containers, modeled on `githubSync/worker.integration.test.ts`; fresh `lastSyncAt` so no network needed):

```ts
import { githubDeliveryReports } from "@caliber/db";
import { createGithubDeliveryQueue, enqueueGithubDelivery } from "../../../src/workers/githubDelivery/queue.js";
import { createGithubDeliveryWorker } from "../../../src/workers/githubDelivery/worker.js";

it("processes an enqueued delivery job end-to-end into github_delivery_reports", async () => {
  const org = await insertOrg(db);
  await insertConnection(db, org.id, { lastSyncAt: new Date() }); // fresh → no sync, no fetch
  const member = await insertMember(db, 777);
  // seed activity rows clearing DELIVERY_MIN_EVENTS (1 merged PR + 2 reviews, shapes from Task 6's test)

  const queue = createGithubDeliveryQueue({ connection: redisConnection });
  const worker = createGithubDeliveryWorker({ connection: redisConnection, db, masterKeyHex: MASTER_KEY });
  try {
    await enqueueGithubDelivery(queue, {
      orgId: org.id, userId: member.id,
      periodStart: "2026-06-16T00:00:00.000Z", periodEnd: "2026-07-16T00:00:00.000Z",
      periodType: "daily", triggeredBy: "manual",
    });
    const deadline = Date.now() + 15_000;
    let rows: Array<{ userId: string }> = [];
    while (Date.now() < deadline) {
      rows = (await db.select().from(githubDeliveryReports)).filter((r) => r.userId === member.id);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(rows).toHaveLength(1);
  } finally {
    await worker.close();
    await queue.close();
  }
});
```

- [ ] **Step 3: Run both to verify they fail** — `pnpm --filter @caliber/gateway test:integration githubDelivery/weeklyCron githubDelivery/worker` → FAIL (modules not found).

- [ ] **Step 4: Write `worker.ts`**

```ts
/** github-delivery worker (PR2). Concurrency 1 — scoring is DB-bound. */
import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import {
  GITHUB_DELIVERY_QUEUE_NAME,
  GITHUB_DELIVERY_QUEUE_PREFIX,
  GithubDeliveryJobPayload,
} from "./queue.js";
import { runDeliveryEval } from "./runDeliveryEval.js";

export interface CreateGithubDeliveryWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
  /** Test seam; threaded to the staleness-gated inline sync. */
  fetchImpl?: typeof fetch;
}

export function createGithubDeliveryWorker(
  opts: CreateGithubDeliveryWorkerOptions,
): Worker<GithubDeliveryJobPayload, void> {
  return new Worker<GithubDeliveryJobPayload, void>(
    GITHUB_DELIVERY_QUEUE_NAME,
    async (job) => {
      const payload = GithubDeliveryJobPayload.parse(job.data);
      await runDeliveryEval({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        payload,
        fetchImpl: opts.fetchImpl,
      });
    },
    {
      connection: opts.connection,
      prefix: GITHUB_DELIVERY_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 1,
    } satisfies WorkerOptions,
  );
}
```

- [ ] **Step 5: Write `weeklyCron.ts`** — copy the coalescing `scheduleTick`/epoch-guard/stopped-flag shape from `../githubSync/interval.ts` (the fixed version) verbatim, swapping the tick body:

```ts
/**
 * Weekly delivery-report cron (PR2). Fires Mondays 03:xx UTC (spec said
 * "server time"; UTC matches the evaluator cron convention). Hourly tick;
 * day-aligned rolling-30d windows make jobIds stable across same-Monday
 * repeat ticks, which dedup against completed hashes (plain add — the
 * regenerate path is manual-only).
 */
export const GITHUB_DELIVERY_CRON_INTERVAL_MS = 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function shouldRunWeeklyDelivery(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 3;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
```

tick body (inside the copied interval skeleton; imports: `and`, `eq`, `isNull` from drizzle-orm; `accounts`, `githubConnections`, `organizationMembers`, `organizations` from `@caliber/db`; `enqueueGithubDelivery` from `./queue.js`):

```ts
  async function tick(): Promise<void> {
    const now = opts.clock?.() ?? new Date();
    if (!shouldRunWeeklyDelivery(now)) return;

    const members = await opts.db
      .selectDistinct({
        orgId: githubConnections.orgId,
        userId: organizationMembers.userId,
      })
      .from(githubConnections)
      .innerJoin(organizations, eq(githubConnections.orgId, organizations.id))
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.orgId, githubConnections.orgId),
      )
      .innerJoin(
        accounts,
        and(
          eq(accounts.userId, organizationMembers.userId),
          eq(accounts.provider, "github"),
        ),
      )
      .where(
        and(
          eq(githubConnections.deliveryEnabled, true),
          isNull(organizations.deletedAt),
        ),
      );

    const periodEnd = startOfUtcDay(now);
    const periodStart = new Date(periodEnd.getTime() - THIRTY_DAYS_MS);

    for (const m of members) {
      if (stopped) return;
      try {
        await enqueueGithubDelivery(opts.queue, {
          orgId: m.orgId,
          userId: m.userId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          periodType: "daily",
          triggeredBy: "cron",
        });
      } catch (err) {
        opts.logger.error({ err, orgId: m.orgId, userId: m.userId }, "github-delivery enqueue failed");
      }
    }
    if (members.length > 0) {
      opts.logger.info({ members: members.length }, "github-delivery weekly tick enqueued");
    }
  }
```

`StartGithubDeliveryCronOptions = { db; queue: QueueLike; logger: LoggerLike; intervalMs?: number; clock?: () => Date }` — reuse `QueueLike` from `../githubSync/queue.js` and copy `LoggerLike` from `interval.ts`. (If `selectDistinct` isn't available in this drizzle version, use `.select(...)` + a TS-side `Map` dedup on `orgId+userId` — note it in the report.)

- [ ] **Step 6: Wire into `wireGithubSyncPipeline`** (`apps/gateway/src/server.ts:714+`) — after the existing sync worker/interval creation, add:

```ts
  const deliveryQueue = createGithubDeliveryQueue({ connection: githubRedis });
  const deliveryWorker = createGithubDeliveryWorker({
    connection: githubRedis,
    db: app.db,
    masterKeyHex,
  });
  const deliveryCronHandle = startGithubDeliveryCron({
    db: app.db,
    queue: deliveryQueue,
    logger: app.log,
  });
```

and extend the existing onClose hook: `deliveryCronHandle.stop()` alongside `cronHandle.stop()`, then `deliveryWorker.close()` and `deliveryQueue.close()` (each try/catch-guarded, same idiom) BEFORE `githubRedis.quit()`. Imports next to the githubSync ones.

- [ ] **Step 7: Run everything** — `pnpm --filter @caliber/gateway test:integration githubDelivery && pnpm --filter @caliber/gateway typecheck` → cron 3 + worker 1 + Tasks 6-7 tests all PASS; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/workers/githubDelivery/ apps/gateway/src/server.ts apps/gateway/tests/workers/githubDelivery/
git commit -m "feat(gateway): github-delivery worker + Monday-03UTC weekly cron, wired in sync pipeline"
```

---

### Task 9: API — `generate` / `getReport` / `listActivity` + delivery-queue injection

**Files:**
- Modify: `apps/api/src/trpc/routers/githubDelivery.ts` (3 new procedures + duplicated delivery-queue constants + `GithubDeliveryQueue` interface)
- Modify: `apps/api/src/trpc/context.ts` + `apps/api/src/trpc/procedures.ts` (thread `githubDeliveryQueue?` exactly like `githubSyncQueue` — PR 1 Task 14 precedent, `procedures.ts:353,375` shape)
- Modify: `apps/api/src/server.ts` (second `Queue("github-delivery", …)` in the existing `ENABLE_GITHUB_DELIVERY && REDIS_URL` block, sharing `bullmqRedis`; close it in the consolidated onClose hook alongside the others)
- Test: `apps/api/tests/integration/trpc/githubDelivery.test.ts` (extend the existing file — its callerFor/envWithFlag/stubProbeFetch setup already exists)

**Interfaces:**
- Consumes: `delivery.read_user` (Task 4), `github.manage` (PR 1), `githubDeliveryReports` + activity tables, `githubConnections`.
- Produces:
  - `generate({ orgId, userId, from, to })` — `github.manage`; window ≤ `MAX_GENERATE_WINDOW_DAYS = 92` (BAD_REQUEST beyond, mirroring `reports.rerun`'s cap); connection must exist → NOT_FOUND; enqueue with `regenerate` semantics (remove-before-add, duplicated inline like the sync constants — jobId builder copied byte-for-byte from the gateway module with the lockstep comment); no queue → `{ enqueued: false, testMode: true }`.
  - `getReport({ orgId, userId, from, to })` — `delivery.read_user`; latest report row overlapping the window (`periodStart <= to AND periodEnd >= from`, order `periodStart` desc, limit 1) or `null`; NEVER returns llm columns that don't exist yet — select explicit safe fields (id, periodStart, periodEnd, periodType, totalScore, insufficientData, sectionScores, metrics, llmStatus, triggeredBy, updatedAt).
  - `listActivity({ orgId, userId, from, to, limit? })` — `delivery.read_user`; `limit` zod `.int().min(1).max(200).default(50)`; resolves the member's github numeric id via the same `accounts` join (inline here — apps/api can't import the gateway module; 6-line duplicate with a lockstep comment); returns `{ ghUserId: number | null, pulls: [...], issues: [...], reviews: [...] }` — display-safe fields only (repoFullName, number, title, htmlUrl, state, timestamps, counts), pulls where `authorGhId = ghUserId` ordered `mergedAt` desc (nulls last) limited, issues where member is closer-or-assignee (fetch org+window rows, TS filter — same pragmatism as the worker), reviews where `reviewerGhId = ghUserId`.

Payload for generate (must parse against the gateway's `GithubDeliveryJobPayload`): `{ orgId, userId, periodStart: from(ISO), periodEnd: to(ISO), periodType: "daily", triggeredBy: "manual" }`.

- [ ] **Step 1: Write the failing integration tests** (extend the existing describe file; new cases):

```ts
const FROM = "2026-06-16T00:00:00.000Z";
const TO = "2026-07-16T00:00:00.000Z";

it("generate: admin-gated, caps at 92 days, requires a connection, enqueues with regenerate semantics", async () => {
  stubProbeFetch(true);
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const member = await makeUser(t.db, { orgId: org.id });

  const calls: string[] = [];
  const queue = {
    add: async (_n: string, data: unknown, opts?: { jobId?: string }) => void calls.push(`add:${(opts?.jobId ?? "")}`),
    remove: async (jobId: string) => void calls.push(`remove:${jobId}`),
  };
  const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag, githubDeliveryQueue: queue });

  // no connection yet → NOT_FOUND
  await expect(caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });

  await caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });

  // >92d → BAD_REQUEST
  await expect(caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: "2026-01-01T00:00:00.000Z", to: TO }))
    .rejects.toMatchObject({ code: "BAD_REQUEST" });

  const res = await caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO });
  expect(res.enqueued).toBe(true);
  expect(calls[0]).toMatch(/^remove:ghdel_v1_/);          // regenerate = remove-before-add
  expect(calls[1]).toMatch(/^add:ghdel_v1_/);
  expect(res.jobId).not.toContain(":");

  // member (not admin) cannot generate
  const memberCaller = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
  await expect(memberCaller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("getReport: self OR org_admin; returns latest overlapping row or null", async () => {
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
  const member = await makeUser(t.db, { orgId: org.id });
  const stranger = await makeUser(t.db, { orgId: org.id });

  await t.db.insert(githubDeliveryReports).values({
    orgId: org.id, userId: member.id,
    periodStart: new Date(FROM), periodEnd: new Date(TO), periodType: "daily",
    totalScore: "88.5", insufficientData: false,
    sectionScores: [], metrics: { windowDays: 30 }, llmStatus: "skipped", triggeredBy: "manual",
  });

  const self = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
  const got = await self.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO });
  expect(got).toMatchObject({ totalScore: "88.5", llmStatus: "skipped" });

  const adminCaller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
  expect(await adminCaller.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO })).not.toBeNull();

  // non-overlapping window → null
  expect(await self.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: "2025-01-01T00:00:00.000Z", to: "2025-02-01T00:00:00.000Z" })).toBeNull();

  // another member → FORBIDDEN
  const strangerCaller = await callerFor({ db: t.db, userId: stranger.id, env: envWithFlag });
  await expect(strangerCaller.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("listActivity: returns display-safe activity for the member's github id; ghUserId null when unlinked", async () => {
  const org = await makeOrg(t.db);
  const member = await makeUser(t.db, { orgId: org.id });
  await t.db.insert(accounts).values({ userId: member.id, type: "oauth", provider: "github", providerAccountId: "777" });
  await t.db.insert(githubPullRequests).values({
    orgId: org.id, repoFullName: "acme/web", number: 1, ghNodeId: "PR_1",
    authorGhId: 777, authorLogin: "me", state: "closed", title: "t", htmlUrl: "u", baseRef: "main",
    ghCreatedAt: new Date("2026-07-01T00:00:00Z"), mergedAt: new Date("2026-07-02T00:00:00Z"),
  });

  const self = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
  const a = await self.githubDelivery.listActivity({ orgId: org.id, userId: member.id, from: FROM, to: TO });
  expect(a.ghUserId).toBe(777);
  expect(a.pulls).toHaveLength(1);
  expect(a.pulls[0]).toMatchObject({ repoFullName: "acme/web", number: 1, htmlUrl: "u" });

  const unlinked = await makeUser(t.db, { orgId: org.id });
  const u = await callerFor({ db: t.db, userId: unlinked.id, env: envWithFlag });
  const empty = await u.githubDelivery.listActivity({ orgId: org.id, userId: unlinked.id, from: FROM, to: TO });
  expect(empty.ghUserId).toBeNull();
  expect(empty.pulls).toEqual([]);
});
```

(Add imports: `githubDeliveryReports`, `githubPullRequests`, `accounts` from `@caliber/db`; extend the local `callerFor` to accept `githubDeliveryQueue` the same way it accepts `githubSyncQueue`.)

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @caliber/api test:integration githubDelivery` → FAIL (unknown procedures).

- [ ] **Step 3: Implement** — in `githubDelivery.ts` add (following the file's existing idioms; `dateInput = z.string().datetime()`):

```ts
const GITHUB_DELIVERY_JOB_NAME = "github-delivery";
const MAX_GENERATE_WINDOW_DAYS = 92;
/** Keep in lockstep with apps/gateway/src/workers/githubDelivery/queue.ts. */
function buildGithubDeliveryJobId(input: { orgId: string; userId: string; periodStart: string }): string {
  return ["ghdel", "v1", input.orgId, input.userId, input.periodStart].join("_").replaceAll(":", "-");
}
export interface GithubDeliveryQueue {
  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<unknown>;
  remove?(jobId: string): Promise<unknown>;
}
```

- `generate`: input `orgIdInput.extend({ userId: z.string().uuid(), from: z.string().datetime(), to: z.string().datetime() })`. Gate `github.manage`; `to > from` and `(to - from) <= 92d` else BAD_REQUEST (message mirrors `reports.rerun`'s "Window exceeds 92 days"); connection existence check (same select as `syncNow`); `const queue = ctx.githubDeliveryQueue; if (!queue) return { enqueued: false, testMode: true as const };` then remove-before-add (try/catch around `queue.remove?.(jobId)`) + `queue.add(GITHUB_DELIVERY_JOB_NAME, payload, { jobId })`; return `{ enqueued: true as const, jobId }`.
- `getReport`: gate `can(ctx.perm, { type: "delivery.read_user", orgId, targetUserId: input.userId })`; drizzle: `and(eq(orgId), eq(userId), lte(periodStart, new Date(to)), gte(periodEnd, new Date(from)))`, `orderBy(desc(githubDeliveryReports.periodStart))`, limit 1, explicit safe-field select; return row ?? null.
- `listActivity`: gate `delivery.read_user`; resolve gh id (inline accounts select + `Number.isFinite` guard, lockstep comment referencing `fetchActivity.ts`); null → `{ ghUserId: null, pulls: [], issues: [], reviews: [] }`; else three selects mirroring Task 6's narrowing (pulls by author+mergedAt window desc nulls-last limit; issues org+window then TS closer-or-assignee filter, slice(limit); reviews by reviewer+window desc limit) with display-safe field lists.
- Wire `githubDeliveryQueue` through `context.ts`/`procedures.ts`/`server.ts` exactly like `githubSyncQueue` (three additive lines each; server.ts adds the second `new Queue("github-delivery", { prefix: "caliber:gw", connection: bullmqRedis, defaultJobOptions: <same object> })` and closes it in the consolidated hook).

- [ ] **Step 4: Run to verify green** — `pnpm --filter @caliber/api test:integration githubDelivery && pnpm --filter @caliber/api typecheck` → all cases (PR 1's 6 + these 3) PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/
git commit -m "feat(api): delivery generate/getReport/listActivity + github-delivery queue injection"
```

---

### Task 10: Full verification + PR

- [ ] **Step 1:** `pnpm turbo run lint typecheck test` → 38/38; `pnpm --filter @caliber/gateway test:integration` and `pnpm --filter @caliber/api test:integration` → all green.
- [ ] **Step 2:** Push (gh account gotcha: `gh auth switch --user hanfour && gh auth setup-git` first): `git push -u origin feat/github-delivery-pr2-scoring`.
- [ ] **Step 3:** PR per repo convention (TL;DR / Why / What / Tests with counts / Verification / Out of scope). Note: still dark; no migration; PR 3 (LLM layer) + PR 4 (UI) follow; the `delivery.read_user` self-access means members can read their own reports via API even before the UI exists. Do NOT write `Close #NN`.
- [ ] **Step 4:** Invoke superpowers:requesting-code-review (final whole-branch review) before merging.

---

## Coverage / deviation notes

- **Spec deviations locked here:** weekly cron fires Monday 03 UTC (spec said "server time" — aligned to the evaluator's UTC convention); cron skips members without github accounts (their no-identity rows come from manual generate only).
- **Deferred to PR 3:** everything LLM (`llm_quality_adjustment`, narrative, evidence, budget, ±15 clamp) — `llm_status` stays `"skipped"`.
- **Deferred to PR 4:** all UI (delivery tab, leaderboard column, i18n).
- The pure-scoring seam (`packages/evaluator/src/delivery/`) is deliberately DB-free so PR 3's quality adjustment composes as `clamp(quant + adjustment, 0, 120)` without touching the worker's fetch layer.
