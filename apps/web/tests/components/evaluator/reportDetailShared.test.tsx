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
