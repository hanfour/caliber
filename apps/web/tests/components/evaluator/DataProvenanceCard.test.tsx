import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataProvenanceCard } from "@/components/evaluator/DataProvenanceCard";

it("renders source split and coverage", () => {
  render(
    <DataProvenanceCard
      sourceBreakdown={{ gateway_events: 12, transcript_events: 1823 }}
      dataQuality={{ coverageRatio: 0.87, capturedRequests: 100, missingBodies: 15, totalRequests: 115 }}
      period={{ requestCount: 115, bodyCount: 100 }}
    />,
  );
  expect(screen.getByText(/1823/)).toBeInTheDocument(); // telemetry events
  expect(screen.getByText(/12/)).toBeInTheDocument(); // gateway events
  expect(screen.getByText(/87%/)).toBeInTheDocument(); // coverage
});

it("returns null when no dataQuality (nothing to explain)", () => {
  const { container } = render(<DataProvenanceCard />);
  expect(container.firstChild).toBeNull();
});

it("handles null sourceBreakdown (per-key reports) without crashing", () => {
  render(
    <DataProvenanceCard
      sourceBreakdown={null}
      dataQuality={{ coverageRatio: 0.5 }}
    />,
  );
  expect(screen.getByText(/50%/)).toBeInTheDocument();
});
