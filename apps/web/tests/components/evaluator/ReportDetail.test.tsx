import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    reports: {
      getUser: { useQuery: vi.fn() },
      rerun: { useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })) },
      facetSummary: { useQuery: vi.fn(() => ({ data: null, isLoading: false, error: null })) },
    },
    rubrics: { get: { useQuery: vi.fn() } },
  },
}));
vi.mock("@/components/RequirePerm", () => ({ RequirePerm: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { ReportDetail } from "@/components/evaluator/ReportDetail";
import { trpc } from "@/lib/trpc/client";

const getUser = trpc.reports.getUser.useQuery as unknown as ReturnType<typeof vi.fn>;
const rubricGet = trpc.rubrics.get.useQuery as unknown as ReturnType<typeof vi.fn>;

const report = {
  totalScore: "112.0",
  periodStart: "2026-07-06T00:00:00.000Z",
  rubricId: "rub-1",
  sectionScores: [
    { sectionId: "interaction", name: "Interaction", weight: 50, standardScore: 100, superiorScore: 120, score: 100, label: "Standard", signals: [{ id: "kw", type: "keyword", hit: false }] },
  ],
  sourceBreakdown: { gateway_events: 0, transcript_events: 1823 },
  dataQuality: { coverageRatio: 0.87, capturedRequests: 100 },
  signalsSummary: { period: { requestCount: 115, bodyCount: 100 } },
  llmNarrative: null,
  reportAudience: "admin" as const,
  generatedReport: {
    title: "Admin rubric report",
    executiveSummary: "The engineer meets the configured standard.",
    performanceAssessment: "The available signals are stable.",
    strengths: [],
    concerns: [],
    coachingPlan: [],
    calibrationNotes: [],
    dataLimitations: [],
  },
  llmModel: null,
  llmCalledAt: null,
};

describe("ReportDetail", () => {
  beforeEach(() => {
    getUser.mockReset();
    rubricGet.mockReset();
  });

  it("renders score, provenance card, and a missed signal with threshold", () => {
    getUser.mockReturnValue({ data: [report], isLoading: false, error: null });
    rubricGet.mockReturnValue({
      data: { definition: { sections: [{ id: "interaction", signals: [{ id: "kw", type: "keyword", minRatio: 0.5 }] }] } },
      isLoading: false,
      error: null,
    });
    render(<ReportDetail orgId="org-1" userId="u-1" userName="Steve" />);
    expect(screen.getByText("112.0")).toBeInTheDocument();
    expect(screen.getByText("Admin rubric report")).toBeInTheDocument();
    expect(screen.getByText(/Data provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/1823/)).toBeInTheDocument();
  });
});
