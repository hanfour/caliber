import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    reports: {
      getOwnLatest: { useQuery: vi.fn() },
      getOwnRange: { useQuery: vi.fn() },
      facetSummary: { useQuery: vi.fn(() => ({ data: null, isLoading: false, error: null })) },
    },
    rubrics: { get: { useQuery: vi.fn() } },
    useUtils: vi.fn(() => ({})),
  },
}));
// These children are unrelated to the explainability parity under test and
// pull in their own trpc surface (me.captureDisclosure, exportOwn, deleteOwn,
// project-scoped rubric editor) — stub them so the test stays focused.
vi.mock("@/components/evaluator/ProfileBanner", () => ({ ProfileBanner: () => null }));
vi.mock("@/components/evaluator/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("@/components/evaluator/DeleteRequestDialog", () => ({ DeleteRequestDialog: () => null }));
vi.mock("@/components/evaluator/ProjectScoreSection", () => ({ ProjectScoreSection: () => null }));

import { ProfileEvaluation } from "@/components/evaluator/ProfileEvaluation";
import { trpc } from "@/lib/trpc/client";

const getOwnLatest = trpc.reports.getOwnLatest.useQuery as unknown as ReturnType<typeof vi.fn>;
const getOwnRange = trpc.reports.getOwnRange.useQuery as unknown as ReturnType<typeof vi.fn>;
const rubricGet = trpc.rubrics.get.useQuery as unknown as ReturnType<typeof vi.fn>;

const report = {
  orgId: "org-1",
  userId: "u-1",
  totalScore: "112.0",
  periodStart: "2026-07-06T00:00:00.000Z",
  periodEnd: "2026-07-07T00:00:00.000Z",
  rubricId: "rub-1",
  sectionScores: [
    {
      sectionId: "interaction",
      name: "Interaction",
      weight: 50,
      standardScore: 100,
      superiorScore: 120,
      score: 100,
      label: "Standard",
      signals: [{ id: "kw", type: "keyword", hit: false }],
    },
  ],
  sourceBreakdown: { gateway_events: 0, transcript_events: 1823 },
  dataQuality: { coverageRatio: 0.87, capturedRequests: 100 },
  signalsSummary: { period: { requestCount: 115, bodyCount: 100 } },
  llmNarrative: null,
  llmModel: null,
  llmCalledAt: null,
};

describe("ProfileEvaluation", () => {
  beforeEach(() => {
    getOwnLatest.mockReset();
    getOwnRange.mockReset();
    rubricGet.mockReset();
  });

  it("renders score, provenance card, and a missed signal's threshold", () => {
    getOwnLatest.mockReturnValue({ data: report, isLoading: false, error: null });
    getOwnRange.mockReturnValue({ data: [report], isLoading: false, error: null });
    rubricGet.mockReturnValue({
      data: {
        definition: {
          sections: [{ id: "interaction", signals: [{ id: "kw", type: "keyword", minRatio: 0.5 }] }],
        },
      },
      isLoading: false,
      error: null,
    });

    render(<ProfileEvaluation />);

    expect(screen.getByText("112.0")).toBeInTheDocument();
    expect(screen.getByText(/Data provenance/i)).toBeInTheDocument();
    expect(screen.getByText(/1823/)).toBeInTheDocument();

    // Expand the section row to reveal the missed signal's threshold text.
    fireEvent.click(screen.getByText("Interaction"));
    expect(screen.getByText(/of bodies contain a term/i)).toBeInTheDocument();
  });
});
