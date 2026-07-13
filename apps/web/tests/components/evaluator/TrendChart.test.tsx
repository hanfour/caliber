import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrendChart, type ScorePoint } from "@/components/evaluator/TrendChart";

const series: ScorePoint[] = [
  { date: "2026-07-01", score: 90 },
  { date: "2026-07-08", score: 96.4 },
];

describe("TrendChart", () => {
  it("draws the 108 pass line and labels it", () => {
    render(<TrendChart series={series} />);
    expect(screen.getByText("108")).toBeInTheDocument();
    expect(screen.getByText(/pass 108/i)).toBeInTheDocument();
  });

  it("shows empty state with no data", () => {
    render(<TrendChart series={[]} />);
    expect(screen.getByText(/No data for this period/i)).toBeInTheDocument();
  });
});
