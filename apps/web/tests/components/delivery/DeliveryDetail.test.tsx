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

  it("calls generate.mutate with the memoized range and shows the queued toast on success", () => {
    getReportQuery.mockReturnValue({ data: fullReport, isLoading: false, error: null });
    render(<DeliveryDetail orgId="org-1" userId="u-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate delivery report" }));

    expect(generateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "u-1",
        from: expect.any(String),
        to: expect.any(String),
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
