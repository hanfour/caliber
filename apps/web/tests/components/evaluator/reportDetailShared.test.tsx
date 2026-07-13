import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SectionRow, type SectionResult } from "@/components/evaluator/reportDetailShared";

const section: SectionResult = {
  sectionId: "interaction",
  name: "Interaction",
  weight: 50,
  standardScore: 100,
  superiorScore: 120,
  score: 100,
  label: "Standard",
  signals: [
    { id: "kw", type: "keyword", hit: false },
    { id: "iter", type: "iteration_count", hit: true, value: 5 },
  ],
};

it("expands to show ALL signals including the missed one, with thresholds", () => {
  render(
    <table>
      <tbody>
        <SectionRow
          section={section}
          rubricSection={{
            signals: [
              { id: "kw", type: "keyword", minRatio: 0.5 },
              { id: "iter", type: "iteration_count", gte: 3 },
            ],
          }}
        />
      </tbody>
    </table>,
  );
  fireEvent.click(screen.getByText("Interaction"));
  expect(screen.getByTestId("signal-kw")).toHaveAttribute("data-hit", "false");
  expect(screen.getByTestId("signal-iter")).toHaveAttribute("data-hit", "true");
  expect(screen.getByText(/≥ 50% of bodies contain a term/)).toBeInTheDocument();
  expect(screen.getByText(/iteration_count ≥ 3/)).toBeInTheDocument();
});

const continuousSection: SectionResult = {
  sectionId: "satisfaction",
  name: "Satisfaction",
  weight: 25,
  mode: "continuous",
  standardScore: 84,
  superiorScore: 120,
  score: 96.4,
  maxScore: 120,
  label: "On track",
  signals: [
    {
      id: "helpfulness",
      type: "facet_claude_helpfulness",
      hit: true,
      value: 4.2,
      earnedPoints: 42.5,
      maxPoints: 50,
      sampleCount: 18,
    },
  ],
};

it("continuous section renders score/maxScore and no superior pill even when score === superiorScore", () => {
  render(
    <table>
      <tbody>
        <SectionRow section={{ ...continuousSection, score: 120 }} />
      </tbody>
    </table>,
  );
  expect(screen.getByText("120.0 / 120")).toBeInTheDocument();
  expect(screen.queryByText("Superior")).not.toBeInTheDocument();
});

it("continuous section renders score.toFixed(1) / maxScore", () => {
  render(
    <table>
      <tbody>
        <SectionRow section={continuousSection} />
      </tbody>
    </table>,
  );
  expect(screen.getByText("96.4 / 120")).toBeInTheDocument();
});

it("null score renders the insufficient-data badge instead of a number", () => {
  render(
    <table>
      <tbody>
        <SectionRow section={{ ...continuousSection, score: null }} />
      </tbody>
    </table>,
  );
  expect(screen.getByText("Insufficient data")).toBeInTheDocument();
});
