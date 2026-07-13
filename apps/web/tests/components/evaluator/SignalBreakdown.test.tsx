import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignalBreakdown } from "@/components/evaluator/SignalBreakdown";

const rubricSignals = {
  iter: { id: "iter", type: "iteration_count", gte: 3 },
  kw: { id: "kw", type: "keyword", minRatio: 0.5 },
};

describe("SignalBreakdown", () => {
  it("shows a hit signal with its value and threshold", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "iter", type: "iteration_count", hit: true, value: 5 }]}
        rubricSignals={rubricSignals}
      />,
    );
    expect(screen.getByText("iter")).toBeInTheDocument();
    expect(screen.getByText(/iteration_count ≥ 3/)).toBeInTheDocument();
    // measured value surfaced
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  it("shows a MISSED signal (this is the whole point — why the score isn't higher)", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "kw", type: "keyword", hit: false }]}
        rubricSignals={rubricSignals}
      />,
    );
    const row = screen.getByTestId("signal-kw");
    expect(row).toHaveAttribute("data-hit", "false");
    expect(screen.getByText(/≥ 50% of bodies contain a term/)).toBeInTheDocument();
  });

  it("renders evidence quotes for hits that carry evidence", () => {
    render(
      <SignalBreakdown
        signals={[
          {
            id: "kw",
            type: "keyword",
            hit: true,
            evidence: [{ quote: "let's compare", requestId: "req-1", offset: 0 }],
          },
        ]}
        rubricSignals={rubricSignals}
      />,
    );
    expect(screen.getByText(/let's compare/)).toBeInTheDocument();
    expect(screen.getByText(/req-1/)).toBeInTheDocument();
  });

  it("degrades gracefully with no rubricSignals (no threshold shown, no crash)", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "iter", type: "iteration_count", hit: true, value: 5 }]}
      />,
    );
    expect(screen.getByText("iter")).toBeInTheDocument();
  });

  it("renders empty state when there are no signals", () => {
    render(<SignalBreakdown signals={[]} />);
    expect(screen.getByText(/No signals/i)).toBeInTheDocument();
  });

  it("renders earnedPoints / maxPoints and sample count for continuous signals", () => {
    render(
      <SignalBreakdown
        signals={[
          {
            id: "helpfulness",
            type: "facet_claude_helpfulness",
            hit: true,
            value: 4.2,
            earnedPoints: 42.5,
            maxPoints: 50,
            sampleCount: 18,
          },
        ]}
      />,
    );
    expect(screen.getByText(/42\.5 \/ 50 pts/)).toBeInTheDocument();
    expect(screen.getByText(/n=18/)).toBeInTheDocument();
  });

  it("omits points/sample rendering when earnedPoints is absent (tiered signal)", () => {
    render(
      <SignalBreakdown
        signals={[{ id: "iter", type: "iteration_count", hit: true, value: 5 }]}
        rubricSignals={rubricSignals}
      />,
    );
    expect(screen.queryByText(/pts/)).not.toBeInTheDocument();
    expect(screen.queryByText(/n=/)).not.toBeInTheDocument();
  });
});
