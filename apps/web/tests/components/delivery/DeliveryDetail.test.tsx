import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock("@/components/RequirePerm", () => ({
  RequirePerm: ({ children }: { children: React.ReactNode }) => children,
}));

const getReportQuery = vi.fn();
const generateMutate = vi.fn();
const invalidateGetReport = vi.fn();
let generateOptions: {
  onSuccess?: () => void;
  onError?: (e: unknown) => void;
} = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      githubDelivery: { getReport: { invalidate: invalidateGetReport } },
    }),
    githubDelivery: {
      getReport: { useQuery: (...a: unknown[]) => getReportQuery(...a) },
      generate: {
        useMutation: (opts: typeof generateOptions) => {
          generateOptions = opts ?? {};
          return { mutate: generateMutate, isPending: false };
        },
      },
    },
  },
}));

import { DeliveryDetail } from "@/components/delivery/DeliveryDetail";

// ── Fixture ───────────────────────────────────────────────────────────────────

const fullReport = {
  totalScore: "88.5",
  insufficientData: false,
  sectionScores: [
    {
      key: "throughput",
      weight: 0.4,
      score: 0.75,
      metrics: [
        {
          key: "merged_pr_count",
          value: 6,
          scaledCurve: { zeroAt: 0, fullAt: 8 },
          subscore: 0.75,
        },
        {
          key: "issues_closed_count",
          value: 4,
          scaledCurve: { zeroAt: 0, fullAt: 10 },
          subscore: 0.4,
        },
        {
          key: "project_items_completed",
          value: null,
          scaledCurve: { zeroAt: 0, fullAt: 10 },
          subscore: null,
        },
      ],
    },
    {
      key: "collaboration",
      weight: 0.3,
      score: 0.5,
      metrics: [
        {
          key: "reviews_submitted",
          value: 5,
          scaledCurve: { zeroAt: 0, fullAt: 10 },
          subscore: 0.5,
        },
        {
          key: "distinct_prs_reviewed",
          value: 3,
          scaledCurve: { zeroAt: 0, fullAt: 6 },
          subscore: 0.5,
        },
      ],
    },
    {
      key: "timeliness",
      weight: 0.3,
      score: 0.6,
      metrics: [
        {
          key: "pr_lead_time_hours_median",
          value: 36.2,
          scaledCurve: { zeroAt: 168, fullAt: 24 },
          subscore: 0.6,
        },
        {
          key: "issue_resolution_days_median",
          value: 3.4,
          scaledCurve: { zeroAt: 14, fullAt: 2 },
          subscore: 0.6,
        },
      ],
    },
  ],
  metrics: {
    windowDays: 30,
    totalEvents: 12,
    values: {
      merged_pr_count: 6,
      issues_closed_count: 4,
      reviews_submitted: 5,
      distinct_prs_reviewed: 3,
      pr_lead_time_hours_median: 36.2,
      issue_resolution_days_median: 3.4,
    },
    rubricVersion: "delivery-v1",
  },
  llmStatus: "ok",
  llmQualityAdjustment: "8.00",
  llmNarrative: null,
  llmEvidence: null,
  llmModel: "claude-x",
  llmCalledAt: "2026-07-10T00:00:00.000Z",
  periodStart: "2026-06-10T00:00:00.000Z",
  periodEnd: "2026-07-10T00:00:00.000Z",
};

describe("DeliveryDetail", () => {
  beforeEach(() => {
    getReportQuery.mockReset();
    generateMutate.mockReset();
    invalidateGetReport.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    generateOptions = {};
  });

  it("shows the loading card", () => {
    getReportQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" userName="Steve" />);
    expect(screen.getByText("Loading delivery report…")).toBeInTheDocument();
  });

  it("shows the notEnabled card on a NOT_FOUND error", () => {
    getReportQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "not found", data: { code: "NOT_FOUND" } },
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(
      screen.getByText("GitHub delivery scoring is not enabled for this workspace."),
    ).toBeInTheDocument();
  });

  it("shows the raw error message for a non-NOT_FOUND error", () => {
    getReportQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("shows the empty state with a visible generate button when there is no report yet", () => {
    getReportQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(
      screen.getByText("No delivery report for this window yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate delivery report" }),
    ).toBeInTheDocument();
  });

  it("shows the noIdentity explainer when the member has no linked GitHub account", () => {
    getReportQuery.mockReturnValue({
      data: {
        ...fullReport,
        totalScore: null,
        insufficientData: true,
        sectionScores: [],
        metrics: { noIdentity: true },
      },
      isLoading: false,
      error: null,
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(
      screen.getByText(
        "This member has no linked GitHub account, so delivery activity can't be attributed.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the insufficient-data pill and never renders NaN", () => {
    getReportQuery.mockReturnValue({
      data: {
        ...fullReport,
        totalScore: null,
        insufficientData: true,
        llmStatus: "skipped",
        llmQualityAdjustment: null,
      },
      isLoading: false,
      error: null,
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(screen.getByText("Insufficient data")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("renders the full report: score, adjustment badge, sections, and a metric row", () => {
    getReportQuery.mockReturnValue({ data: fullReport, isLoading: false, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" userName="Steve" />);
    expect(screen.getByText("88.5")).toBeInTheDocument();
    expect(screen.getByText(/\+8\.0/)).toBeInTheDocument();
    expect(screen.getByText("Throughput")).toBeInTheDocument();
    expect(screen.getByText("Collaboration")).toBeInTheDocument();
    expect(screen.getByText("Timeliness")).toBeInTheDocument();
    expect(screen.getByText("Merged PRs")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();

    // PERCENT-LOCK: section scores render as Math.round(score * 100)%, never
    // score*120 (the 0-120 total-score scale) or score*weight. Each section
    // pill is its own text node, so an exact match pins it precisely.
    expect(screen.getByText("75%")).toBeInTheDocument(); // throughput.score = 0.75
    expect(screen.getByText("50%")).toBeInTheDocument(); // collaboration.score = 0.5
    expect(screen.getByText("60%")).toBeInTheDocument(); // timeliness.score = 0.6

    // PERCENT-LOCK: metric subscores render inline as "{value} · {pct}" —
    // assert the full combined text so a regression to score*120/score*weight
    // at the metric level fails loudly too. Some subscores collide in value
    // with their section (e.g. collaboration's two subscores are both 0.5,
    // same as the section score); getAllByText + a length check pins the
    // count instead of assuming a single match.
    expect(screen.getByText("6 · 75%")).toBeInTheDocument(); // merged_pr_count
    expect(screen.getByText("4 · 40%")).toBeInTheDocument(); // issues_closed_count
    expect(screen.getByText("5 · 50%")).toBeInTheDocument(); // reviews_submitted
    expect(screen.getByText("3 · 50%")).toBeInTheDocument(); // distinct_prs_reviewed
    expect(screen.getByText("36.2 · 60%")).toBeInTheDocument(); // pr_lead_time_hours_median
    expect(screen.getByText("3.4 · 60%")).toBeInTheDocument(); // issue_resolution_days_median
    expect(screen.getAllByText(/50%/)).toHaveLength(3); // collaboration section + its 2 subscores
    expect(screen.getAllByText(/60%/)).toHaveLength(3); // timeliness section + its 2 subscores
  });

  it("shows the LLM-skipped note instead of the adjustment badge on parse_error", () => {
    getReportQuery.mockReturnValue({
      data: { ...fullReport, llmStatus: "parse_error", llmQualityAdjustment: null },
      isLoading: false,
      error: null,
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(screen.getByText("Quality review unavailable (parse_error)")).toBeInTheDocument();
  });

  it("shows the LLM-skipped note instead of the adjustment badge on budget_denied", () => {
    getReportQuery.mockReturnValue({
      data: { ...fullReport, llmStatus: "budget_denied", llmQualityAdjustment: null },
      isLoading: false,
      error: null,
    });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);
    expect(screen.getByText("Quality review unavailable (budget_denied)")).toBeInTheDocument();
    expect(screen.queryByText(/\+8\.0/)).toBeNull();
  });

  it("calls generate.mutate with the memoized range and shows the queued toast on success", () => {
    getReportQuery.mockReturnValue({ data: fullReport, isLoading: false, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);

    // Capture the exact from/to the shared memoized range produced for the
    // query, so the mutation-payload assertion below proves real equality
    // with it — not just "some string" (expect.any(String) would pass even
    // if the mutate call used a differently-computed, un-memoized range).
    const queryArgs = getReportQuery.mock.calls[0][0] as { from: string; to: string };

    fireEvent.click(screen.getByRole("button", { name: "Generate delivery report" }));

    expect(generateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "u-1",
        from: queryArgs.from,
        to: queryArgs.to,
      }),
    );

    generateOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("Delivery report queued — refresh shortly.");
    expect(invalidateGetReport).toHaveBeenCalled();
  });

  it("shows the insufficient-permission toast on a FORBIDDEN generate error", () => {
    getReportQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate delivery report" }));
    generateOptions.onError?.({ message: "forbidden", data: { code: "FORBIDDEN" } });
    expect(toastError).toHaveBeenCalledWith("Insufficient permission");
  });
});
