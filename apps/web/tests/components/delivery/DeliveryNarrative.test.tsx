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

  it("filters each malformed evidence item independently while a valid sibling still renders", () => {
    render(
      <DeliveryNarrative
        report={{
          llmStatus: "ok",
          llmNarrative: "Narrative text.",
          llmEvidence: [
            // (a) a stray string, not an object at all.
            "this is not an evidence object",
            // (b) has prNumber but is missing repo.
            { prNumber: 9, quote: "no repo", reason: "dropped" },
            // (c) has repo but is missing prNumber.
            { repo: "caliber/web", quote: "no prNumber", reason: "dropped" },
            // (d) repo is shape-invalid (fails the owner/repo regex, and is
            // the kind of value that would be unsafe to interpolate raw).
            { repo: "javascript:alert(1)//x", prNumber: 1, quote: "unsafe repo", reason: "dropped" },
            // (e) repo has a trailing fragment that isn't a valid repo segment.
            { repo: "acme/web#frag", prNumber: 2, quote: "fragment repo", reason: "dropped" },
            // (f) prNumber is not a positive integer.
            { repo: "caliber/web", prNumber: 1.5, quote: "fractional pr", reason: "dropped" },
            // (g) repo segment is a dot-path — "acme/.." would browser-normalize
            // to github.com/pull/N (misdirected link); must be dropped.
            { repo: "acme/..", prNumber: 3, quote: "dot path repo", reason: "dropped" },
            // Valid sibling in the same array — must still render, proving
            // the filter is per-item and not all-or-nothing.
            { repo: "caliber/web", prNumber: 7, quote: "valid quote", reason: "valid reason" },
          ],
        }}
      />,
    );

    expect(screen.getByText("valid quote")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("no repo")).not.toBeInTheDocument();
    expect(screen.queryByText("no prNumber")).not.toBeInTheDocument();
    expect(screen.queryByText("unsafe repo")).not.toBeInTheDocument();
    expect(screen.queryByText("fragment repo")).not.toBeInTheDocument();
    expect(screen.queryByText("fractional pr")).not.toBeInTheDocument();
    expect(screen.queryByText("dot path repo")).not.toBeInTheDocument();
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
