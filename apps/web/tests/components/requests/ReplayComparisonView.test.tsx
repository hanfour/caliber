import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ replay: { listForRequest: { invalidate } } }),
    replay: {
      getComparison: { useQuery: vi.fn() },
      enqueue: { useMutation: vi.fn() },
    },
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ReplayComparisonView } from "@/components/requests/ReplayComparisonView";
import { trpc } from "@/lib/trpc/client";

const useQuery = trpc.replay.getComparison.useQuery as unknown as ReturnType<
  typeof vi.fn
>;
const useMutation = trpc.replay.enqueue.useMutation as unknown as ReturnType<
  typeof vi.fn
>;

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeSide(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250929",
    responseBody: { content: [{ type: "text", text: "source answer" }] },
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    totalCost: "0.0500000000",
    durationMs: 4321,
    ...overrides,
  };
}

function makeComparison(overrides: Record<string, unknown> = {}) {
  return {
    source: makeSide(),
    replay: makeSide({
      model: "claude-haiku-4-5",
      upstreamModel: "claude-haiku-4-5-20251001",
      responseBody: { content: [{ type: "text", text: "replay answer" }] },
      totalCost: "0.0030000000",
      durationMs: 999,
    }),
    status: "ok",
    failureReason: null,
    fidelity: {
      toolResultTruncated: false,
      originalCacheReadTokens: 0,
      originalAccountId: null,
      originalAccountStillExists: true,
      streamingDisabled: true,
    },
    comparable: { latency: false, cost: true },
    ...overrides,
  };
}

function renderView() {
  return render(
    <ReplayComparisonView
      orgId="11111111-1111-4111-8111-111111111111"
      requestId="req-1"
      runId="22222222-2222-4222-8222-222222222222"
      onRunCreated={() => {}}
    />,
  );
}

/** The metric table row whose header cell is `label`. */
function metricRow(label: string): HTMLElement {
  const header = screen.getByRole("rowheader", { name: label });
  const row = header.closest("tr");
  if (!row) throw new Error(`no row for metric "${label}"`);
  return row as HTMLElement;
}

const mutate = vi.fn();

beforeEach(() => {
  invalidate.mockReset();
  mutate.mockReset();
  useMutation.mockReturnValue({ mutate, isPending: false });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ReplayComparisonView", () => {
  it("puts the fidelity banner ABOVE the comparison content in the document", () => {
    // Positional, not merely present: a caveat rendered under the thing it
    // qualifies has already failed at its job, and "the text exists somewhere"
    // would pass just as happily with it in a footer.
    useQuery.mockReturnValue({ data: makeComparison(), isLoading: false, error: null });
    renderView();

    const banner = screen.getByTestId("fidelity-banner");
    const content = screen.getByTestId("comparison-content");
    expect(
      banner.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("never renders latency as a number, even when cost IS comparable", () => {
    useQuery.mockReturnValue({ data: makeComparison(), isLoading: false, error: null });
    renderView();

    const row = metricRow("Latency");
    expect(within(row).getAllByText("Not comparable")).toHaveLength(2);
    expect(row.textContent).not.toContain("4321");
    expect(row.textContent).not.toContain("999");
    // Stated in the banner AND under the table — getAllByText, because both
    // placements are intentional.
    expect(
      screen.getAllByText(/latency is not comparable/i).length,
    ).toBeGreaterThan(0);
  });

  it("renders cost as a number only when the source ran without a cache read", () => {
    useQuery.mockReturnValue({ data: makeComparison(), isLoading: false, error: null });
    renderView();

    const row = metricRow("Cost");
    expect(row.textContent).toContain("$0.0500");
    expect(row.textContent).toContain("$0.0030");
  });

  it("renders cost as 'not comparable' when the source read from the prompt cache", () => {
    useQuery.mockReturnValue({
      data: makeComparison({
        source: makeSide({ cacheReadTokens: 4096 }),
        comparable: { latency: false, cost: false },
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    const row = metricRow("Cost");
    expect(within(row).getAllByText("Not comparable")).toHaveLength(2);
    // The dollar figures must be gone entirely — a number the reader can
    // subtract is itself a claim that subtracting it means something.
    expect(row.textContent).not.toContain("$");
    expect(
      screen.getAllByText(/cost is not comparable/i).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/read 4096 tokens from the prompt cache/i),
    ).toBeInTheDocument();
  });

  it("shows both response bodies side by side", () => {
    useQuery.mockReturnValue({ data: makeComparison(), isLoading: false, error: null });
    renderView();

    expect(screen.getByTestId("source-response")).toHaveTextContent(
      "source answer",
    );
    expect(screen.getByTestId("replay-response")).toHaveTextContent(
      "replay answer",
    );
  });

  it("says so instead of showing an empty panel when a body cannot be shown", () => {
    useQuery.mockReturnValue({
      data: makeComparison({ source: makeSide({ responseBody: null }) }),
      isLoading: false,
      error: null,
    });
    renderView();

    expect(screen.getByTestId("source-response")).toHaveTextContent(
      /Content cannot be shown/i,
    );
  });

  it("explains a status-suffixed upstream failure with its HTTP code", () => {
    useQuery.mockReturnValue({
      data: makeComparison({
        replay: null,
        status: "failed",
        failureReason: "upstream_error:503",
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
  });

  it("explains a stale claim as a run that never reported back", () => {
    useQuery.mockReturnValue({
      data: makeComparison({
        replay: null,
        status: "failed",
        failureReason: "stale_running",
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    expect(screen.getByText(/never reported back/i)).toBeInTheDocument();
  });

  it("starts the same-model baseline against the SOURCE model", async () => {
    const user = userEvent.setup();
    useQuery.mockReturnValue({ data: makeComparison(), isLoading: false, error: null });
    renderView();

    await user.click(
      screen.getByRole("button", { name: "Run again on the same model" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith({
        orgId: "11111111-1111-4111-8111-111111111111",
        requestId: "req-1",
        // The baseline is worthless if it runs the REPLAY's model: it exists
        // to measure sampling noise for the original, not to repeat the
        // comparison.
        targetModel: "claude-sonnet-4-5",
      }),
    );
  });

  it("tells the reader the deployment cannot decrypt, rather than showing a blank page", () => {
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { data: { code: "PRECONDITION_FAILED" } },
    });
    renderView();

    expect(
      screen.getByText(/no content encryption key configured/i),
    ).toBeInTheDocument();
  });
});
