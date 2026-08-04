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

import {
  POLL_MS,
  ReplayComparisonView,
  WARNED_POLL_MAX_MS,
} from "@/components/requests/ReplayComparisonView";
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
    fidelityUnreadable: false,
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
  return pollOptions(data)({ state: { data } });
}

/**
 * The component's own `refetchInterval`, kept callable across successive
 * polls — the backoff is a property of the SEQUENCE, so a single call cannot
 * observe it.
 */
function pollOptions(
  data: Record<string, unknown>,
): (q: { state: { data: unknown } }) => number | false {
  useQuery.mockReturnValue({ data, isLoading: false, error: null });
  renderView();
  const options = useQuery.mock.calls[0]![1] as {
    refetchInterval: (q: { state: { data: unknown } }) => number | false;
  };
  return options.refetchInterval;
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

  // Under-warning is the ONE direction this banner must not fail in. When the
  // fidelity record cannot be parsed, the tool-result-truncated and
  // account-gone caveats silently vanish from the list — and a comparison
  // missing a caveat reads as MORE like-for-like than it is, which is exactly
  // the misleading conclusion this whole page exists to prevent. Saying "we
  // could not read it" is the honest floor.
  it("says the fidelity record was unreadable instead of silently dropping its caveats", () => {
    useQuery.mockReturnValue({
      data: makeComparison({ fidelity: null, fidelityUnreadable: true }),
      isLoading: false,
      error: null,
    });
    renderView();

    const banner = screen.getByTestId("fidelity-banner");
    expect(within(banner).getByText(/could not be read/i)).toBeInTheDocument();
  });

  it("does not cry unreadable when the run simply carries no fidelity record", () => {
    useQuery.mockReturnValue({
      data: makeComparison({ fidelity: null, fidelityUnreadable: false }),
      isLoading: false,
      error: null,
    });
    renderView();

    const banner = screen.getByTestId("fidelity-banner");
    expect(within(banner).queryByText(/could not be read/i)).toBeNull();
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

  // ── Stalled queue ───────────────────────────────────────────────────────
  // `queued` used to be the one non-terminal state with no bound: the page
  // showed 「排隊中」 and polled forever whenever no replay worker was consuming
  // the queue (the gateway's ENABLE_EVALUATOR off while the API's is on is the
  // ordinary way to get there). It gets the same amber, still-watching
  // treatment as a stale run — a run nothing has claimed can still start.

  it("KEEPS polling a replay nothing has picked up, so a late start can still resolve it", () => {
    expect(
      pollDecision(
        makeComparison({
          replay: null,
          status: "failed",
          failureReason: "stale_queued",
        }),
      ),
    ).toBeGreaterThan(0);
  });

  it("names the operational cause when nothing picks a replay up, instead of blaming the run", () => {
    useQuery.mockReturnValue({
      data: makeComparison({
        replay: null,
        status: "failed",
        failureReason: "stale_queued",
      }),
      isLoading: false,
      error: null,
    });
    renderView();

    expect(screen.getByText(/has not started/i)).toBeInTheDocument();
    // The actionable part: the queue is not being consumed. Telling the
    // operator to "try again" here would buy a second run for the same queue
    // that is already not draining.
    expect(screen.getByText(/replay worker/i)).toBeInTheDocument();
    expect(screen.queryByText("This replay did not finish")).toBeNull();
    expect(
      within(metricRow("Requested model")).getByText("No result yet"),
    ).toBeInTheDocument();
  });

  // ── Poll backoff ────────────────────────────────────────────────────────
  // The trade-off behind polling a warned run is right and must be preserved:
  // a wasted query costs less than wrongly telling an operator to spend
  // another replay. Only the FLAT interval was wrong. `getComparison` does two
  // joins and up to two AES-GCM decrypts of up-to-256KB bodies, so a stranded
  // run with a tab left open was ~1,200 decrypt round trips per hour, forever.

  it("backs off once a run is in a warned state, instead of hammering at a flat 3s", () => {
    const warned = makeComparison({
      replay: null,
      status: "failed",
      failureReason: "stale_running",
    });
    const refetchInterval = pollOptions(warned);

    const seq = [0, 1, 2, 3].map(
      () => refetchInterval({ state: { data: warned } }) as number,
    );

    // Off the fast cadence immediately — by the time the API warns, the page
    // has already polled at 3s for the whole stale window.
    expect(seq[0]).toBeGreaterThan(POLL_MS);
    expect(seq[1]).toBeGreaterThan(seq[0]!);
    // Capped, not unbounded: a run that DOES come back must still be noticed
    // promptly, so the ceiling is the point of the step, not an accident.
    expect(seq[2]).toBe(WARNED_POLL_MAX_MS);
    expect(seq[3]).toBe(WARNED_POLL_MAX_MS);
  });

  it("returns to the fast interval when a warned run resumes, so a late result is not delayed", () => {
    const warned = makeComparison({
      replay: null,
      status: "failed",
      failureReason: "stale_running",
    });
    const refetchInterval = pollOptions(warned);

    refetchInterval({ state: { data: warned } });
    refetchInterval({ state: { data: warned } });
    expect(refetchInterval({ state: { data: warned } })).toBe(
      WARNED_POLL_MAX_MS,
    );

    // The worker came back and the run is now `ok`, just waiting on its usage
    // row. That window is short, so the page must poll it at full speed again.
    const materializing = makeComparison({ replay: null, status: "ok" });
    expect(refetchInterval({ state: { data: materializing } })).toBe(POLL_MS);
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
