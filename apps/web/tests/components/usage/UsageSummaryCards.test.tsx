import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UsageSummaryCards } from "@/components/usage/UsageSummaryCards";

// UsageSummaryCards takes `summary` as a prop (fetched by its parent page),
// so no tRPC mocking is needed here — this suite exists specifically to
// pin that the "Replay cost" tile is bound to `summary.replayCostUsd`, not
// `summary.totalCostUsd` or anything else. totalCostUsd and replayCostUsd
// are deliberately DIFFERENT values below: a static-text assertion (e.g.
// `getByText("Replay cost")`) can't tell a correct binding from a rebound
// or dropped field, since the label renders unconditionally. Only a
// distinct, scoped VALUE assertion can — see review Finding 1 on
// single-request-replay Task 10.
const summary = {
  totalRequests: 42,
  totalCostUsd: "100.0000000000",
  replayCostUsd: "5.0000000000",
  totalInputTokens: 1000,
  totalOutputTokens: 2000,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  byModel: [{ model: "claude-sonnet-4-5", requests: 42, costUsd: "100.0000000000", inputTokens: 1000, outputTokens: 2000 }],
  byKey: [],
};

function replayCostCard() {
  const label = screen.getByText("Replay cost");
  return label.parentElement as HTMLElement;
}

function totalCostCard() {
  const label = screen.getByText("Total cost");
  return label.parentElement as HTMLElement;
}

describe("UsageSummaryCards replay cost tile", () => {
  it("renders the value derived from replayCostUsd, not totalCostUsd", () => {
    render(<UsageSummaryCards summary={summary} isLoading={false} />);

    // The two tiles must show their OWN distinct values. A mutation that
    // rebinds the "Replay cost" tile to summary.totalCostUsd (or drops
    // replayCostUsd from the query and lets it fall back to undefined ->
    // "$0.00") would make this assertion fail.
    expect(within(replayCostCard()).getByText("$5.00")).toBeInTheDocument();
    expect(within(totalCostCard()).getByText("$100.00")).toBeInTheDocument();
  });

  it("shows a distinct value even when replayCostUsd is zero (not conflated with totalCostUsd)", () => {
    render(
      <UsageSummaryCards
        summary={{ ...summary, replayCostUsd: "0.0000000000" }}
        isLoading={false}
      />,
    );

    expect(within(replayCostCard()).getByText("$0.00")).toBeInTheDocument();
    expect(within(totalCostCard()).getByText("$100.00")).toBeInTheDocument();
  });

  it("renders a placeholder (not a crash) while loading, with no bound value yet", () => {
    render(<UsageSummaryCards summary={undefined} isLoading={true} />);

    expect(replayCostCard()).toHaveTextContent("—");
  });
});
