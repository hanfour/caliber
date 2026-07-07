import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LlmEvidenceList } from "@/components/evaluator/LlmEvidenceList";

it("renders each evidence quote with its rationale and request id", () => {
  render(
    <LlmEvidenceList
      evidence={[
        { quote: "let's refactor this", requestId: "req-9", rationale: "shows iterative refinement" },
      ]}
    />,
  );
  expect(screen.getByText(/let's refactor this/)).toBeInTheDocument();
  expect(screen.getByText(/shows iterative refinement/)).toBeInTheDocument();
  expect(screen.getByText(/req-9/)).toBeInTheDocument();
});

it("returns null when evidence is null (redacted or absent)", () => {
  const { container } = render(<LlmEvidenceList evidence={null} />);
  expect(container.firstChild).toBeNull();
});

it("returns null when evidence is an empty array", () => {
  const { container } = render(<LlmEvidenceList evidence={[]} />);
  expect(container.firstChild).toBeNull();
});

it("ignores malformed entries without crashing", () => {
  render(<LlmEvidenceList evidence={[{ quote: "ok", requestId: "r", rationale: "why" }, { bad: 1 }]} />);
  expect(screen.getByText(/ok/)).toBeInTheDocument();
});
