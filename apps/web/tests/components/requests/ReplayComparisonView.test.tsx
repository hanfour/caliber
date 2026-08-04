import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
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
  useQuery.mockReset();
  useMutation.mockReturnValue({ mutate, isPending: false });
});

/**
 * Ask the component's OWN `refetchInterval` what it would do with a given
 * comparison — i.e. whether the page keeps watching this run.
 *
 * Asserting on the rendered spinner would not catch either bug this covers:
 * both are about what happens NEXT, and react-query is mocked out, so the
 * option the component passed is the only place that answer exists.
 */
function pollDecision(data: Record<string, unknown>): number | false {
  useQuery.mockReturnValue({ data, isLoading: false, error: null });
  renderView();
  const options = useQuery.mock.calls[0]![1] as {
    refetchInterval: (q: { state: { data: unknown } }) => number | false;
  };
  return options.refetchInterval({ state: { data } });
}

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
      screen.getByText(/original request read 4096 tokens from the prompt cache/i),
    ).toBeInTheDocument();
  });

  it("suppresses the cost figures when the REPLAY is the warm side (the rule is bidirectional)", () => {
    // Reachable through this feature: the replay inherits the original's
    // cache_control markers verbatim, so a second same-model baseline inside
    // the cache TTL reads warm while the original stayed cold. A source-only
    // rule prints two $ figures here and calls them comparable.
    useQuery.mockReturnValue({
      data: makeComparison({
        source: makeSide({ cacheReadTokens: 0 }),
        replay: makeSide({
          model: "claude-sonnet-4-5",
          cacheReadTokens: 8192,
          totalCost: "0.0030000000",
        }),
        comparable: { latency: false, cost: false },
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    const row = metricRow("Cost");
    expect(within(row).getAllByText("Not comparable")).toHaveLength(2);
    expect(row.textContent).not.toContain("$");
    // And the banner must blame the RIGHT side — "the original read from
    // cache" would simply be false here.
    expect(
      screen.getByText(/this replay read 8192 tokens from the prompt cache/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/original request read .* from the prompt cache/i),
    ).toBeNull();
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

  // ── Run-state reporting ────────────────────────────────────────────────
  // The API's staleness window is measured from row creation (replay_runs has
  // no claim timestamp), so it includes queue time — a healthy run stuck
  // behind a concurrency:1 worker can trip it. Everything below exists so a
  // late-but-successful run can still replace the warning on its own.

  it("KEEPS polling a stale-but-running replay, so a late result can replace the warning", () => {
    expect(
      pollDecision(
        makeComparison({
          replay: null,
          status: "failed",
          failureReason: "stale_running",
        }),
      ),
    ).toBeGreaterThan(0);
  });

  it("warns about a stale run without telling the reader to spend another replay", () => {
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

    expect(screen.getByText(/has not reported back/i)).toBeInTheDocument();
    expect(screen.getByText(/still watching/i)).toBeInTheDocument();
    // The terminal "did not finish" headline would push the operator into
    // re-running a job that may simply be queued — and so would the same
    // wording in the empty metric cells.
    expect(screen.queryByText("This replay did not finish")).toBeNull();
    expect(screen.queryAllByText("Did not finish")).toHaveLength(0);
    expect(
      within(metricRow("Requested model")).getByText("No result yet"),
    ).toBeInTheDocument();
  });

  it("stops polling once the replay's result is declared missing", () => {
    expect(
      pollDecision(
        makeComparison({
          replay: null,
          status: "failed",
          failureReason: "result_missing",
        }),
      ),
    ).toBe(false);
  });

  it("says the replay ran and cost money when its result went missing", () => {
    useQuery.mockReturnValue({
      data: makeComparison({
        replay: null,
        status: "failed",
        failureReason: "result_missing",
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    expect(screen.getByText("This replay did not finish")).toBeInTheDocument();
    expect(screen.getByText(/may have cost money/i)).toBeInTheDocument();
  });

  it("polls while the replay's usage row is still being written, and stops once it lands", () => {
    expect(
      pollDecision(makeComparison({ replay: null, status: "ok" })),
    ).toBeGreaterThan(0);
    cleanup();
    useQuery.mockReset();
    expect(pollDecision(makeComparison())).toBe(false);
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
