import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

vi.mock("@/components/RequirePerm", () => ({
  RequirePerm: ({ children }: { children: React.ReactNode }) => children,
}));

const getReportQuery = vi.fn();

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    githubDelivery: {
      getReport: { useQuery: (...a: unknown[]) => getReportQuery(...a) },
    },
  },
}));

import { DeliveryScoreCell } from "@/components/delivery/DeliveryScoreCell";

describe("DeliveryScoreCell", () => {
  it("renders a muted ellipsis while loading", () => {
    getReportQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<DeliveryScoreCell orgId="org-1" userId="user-1" />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("renders an em dash on error (including NOT_FOUND)", () => {
    getReportQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { data: { code: "NOT_FOUND" } },
    });
    render(<DeliveryScoreCell orgId="org-1" userId="user-1" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders an em dash when data is null", () => {
    getReportQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<DeliveryScoreCell orgId="org-1" userId="user-1" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the insufficient-data pill when insufficientData is true", () => {
    getReportQuery.mockReturnValue({
      data: { totalScore: null, insufficientData: true },
      isLoading: false,
      error: null,
    });
    render(<DeliveryScoreCell orgId="org-1" userId="user-1" />);
    expect(screen.getByText("Insufficient data")).toBeInTheDocument();
  });

  it("renders the colored score to one decimal place with no NaN", () => {
    getReportQuery.mockReturnValue({
      data: { totalScore: "88.5", insufficientData: false },
      isLoading: false,
      error: null,
    });
    render(<DeliveryScoreCell orgId="org-1" userId="user-1" />);
    const el = screen.getByText("88.5");
    expect(el).toBeInTheDocument();
    expect(el.className).toContain("tabular-nums");
    expect(el.className).toContain("font-semibold");
    // must be colored (one of the score color classes), never the raw NaN text
    expect(el.className).toMatch(/text-(sky|emerald|amber|zinc)-\d{3}/);
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });
});
