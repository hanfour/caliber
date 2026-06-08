import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const errorSummaryQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    usage: { errorSummary: { useQuery: (...a: unknown[]) => errorSummaryQuery(...a) } },
  },
}));
import { ErrorRateSection } from "@/components/status/ErrorRateSection";

describe("ErrorRateSection", () => {
  it("renders 0% with zero counts for an empty window", () => {
    errorSummaryQuery.mockReturnValue({
      data: { totalRequests: 0, errorRequests: 0, count429: 0, count5xx: 0 },
      isLoading: false, error: null,
    });
    render(<ErrorRateSection />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("computes the error-rate percentage from counts", () => {
    errorSummaryQuery.mockReturnValue({
      data: { totalRequests: 50, errorRequests: 5, count429: 3, count5xx: 2 },
      isLoading: false, error: null,
    });
    render(<ErrorRateSection />);
    expect(screen.getByText("10%")).toBeInTheDocument(); // 5/50
    expect(screen.getByText("3")).toBeInTheDocument();   // 429
    expect(screen.getByText("2")).toBeInTheDocument();   // 5xx
  });

  it("renders the section error message when the query errors", () => {
    errorSummaryQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<ErrorRateSection />);
    expect(screen.getByText("Couldn't load error stats. Please try again.")).toBeInTheDocument();
  });

  it("shows the loading indicator while the query is in flight", () => {
    errorSummaryQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<ErrorRateSection />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
