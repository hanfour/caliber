import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeliveryNarrative } from "@/components/delivery/DeliveryNarrative";

describe("DeliveryNarrative", () => {
  it("renders the narrative, quote, and a correct evidence link href when llmStatus is ok", () => {
    render(
      <DeliveryNarrative
        report={{
          llmStatus: "ok",
          llmNarrative: "Consistently ships well-tested, focused PRs.",
          llmEvidence: [
            {
              repo: "caliber/web",
              prNumber: 42,
              quote: "Added regression tests before touching the fix.",
              reason: "Shows disciplined TDD practice.",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Quality review")).toBeInTheDocument();
    expect(
      screen.getByText("Consistently ships well-tested, focused PRs."),
    ).toBeInTheDocument();
    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(
      screen.getByText("Added regression tests before touching the fix."),
    ).toBeInTheDocument();
    expect(screen.getByText("Shows disciplined TDD practice.")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /caliber\/web#42/ });
    expect(link).toHaveAttribute("href", "https://github.com/caliber/web/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders nothing when llmStatus is not ok (e.g. parse_error)", () => {
    const { container } = render(
      <DeliveryNarrative
        report={{
          llmStatus: "parse_error",
          llmNarrative: "should never show",
          llmEvidence: [{ repo: "caliber/web", prNumber: 1, quote: "x", reason: "y" }],
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Quality review")).not.toBeInTheDocument();
  });

  it("does not crash and filters out a malformed (non-object) evidence item", () => {
    render(
      <DeliveryNarrative
        report={{
          llmStatus: "ok",
          llmNarrative: "Narrative text.",
          llmEvidence: [
            "this is not an evidence object",
            { repo: "caliber/web", prNumber: 7, quote: "valid quote", reason: "valid reason" },
            { quote: "missing repo/prNumber" },
          ],
        }}
      />,
    );

    // Only the one well-formed item survives the defensive filter.
    expect(screen.getByText("valid quote")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("omits the evidence block entirely when evidence is absent or empty", () => {
    render(
      <DeliveryNarrative
        report={{ llmStatus: "ok", llmNarrative: "Narrative only.", llmEvidence: null }}
      />,
    );
    expect(screen.queryByText("Evidence")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
