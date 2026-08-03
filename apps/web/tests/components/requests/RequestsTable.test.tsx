import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// RequestsTable's replay button opens ReplayDialog on click, which pulls in
// next/navigation's useRouter, sonner's toast, and trpc.replay.enqueue —
// none of that is what THIS suite is verifying (RequestsTable never renders
// ReplayDialog unless a row is clicked, and none of the cases below click
// one). Stub it out, matching TeamLeaderboard.test.tsx's precedent of
// stubbing a sibling component that has its own dedicated suite.
vi.mock("@/components/requests/ReplayDialog", () => ({
  ReplayDialog: () => null,
}));

const useInfiniteQuery = vi.fn();

// Mock the tRPC client *before* importing the component under test so the
// component's `import { trpc } from "@/lib/trpc/client"` resolves to the mock.
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    usage: {
      listRequests: {
        useInfiniteQuery: (...a: unknown[]) => useInfiniteQuery(...a),
      },
    },
  },
}));

import { RequestsTable } from "@/components/requests/RequestsTable";

// ── Fixtures ──────────────────────────────────────────────────────────────

interface RowOverrides {
  requestId?: string;
  requestedModel?: string;
  bodyTruncated?: boolean;
  hasBody?: boolean;
  replayOfRequestId?: string | null;
}

function makeRow(overrides: RowOverrides = {}) {
  return {
    requestId: overrides.requestId ?? "req-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    requestedModel: overrides.requestedModel ?? "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    costUsd: "0.0010000000",
    statusCode: 200,
    durationMs: 150,
    stopReason: "end_turn",
    bodyTruncated: overrides.bodyTruncated ?? false,
    toolResultTruncated: false,
    hasBody: overrides.hasBody ?? true,
    replayOfRequestId: overrides.replayOfRequestId ?? null,
  };
}

/** Base react-query `useInfiniteQuery` result shape RequestsTable reads from. */
function makeQueryResult(opts: {
  rows: ReturnType<typeof makeRow>[];
  replayEnabled: boolean;
}) {
  return {
    error: null,
    isLoading: false,
    data: {
      pages: [{ rows: opts.rows, nextCursor: null, replayEnabled: opts.replayEnabled }],
      pageParams: [undefined],
    },
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
}

const baseProps = {
  orgId: "org-1",
  orgIdentifier: "org-1",
  userId: "user-1",
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  useInfiniteQuery.mockReset();
});

describe("RequestsTable", () => {
  it("replayEnabled: false -> shows the page-level banner and mounts NO replay button anywhere (not even a disabled one)", () => {
    useInfiniteQuery.mockReturnValue(
      makeQueryResult({ rows: [makeRow()], replayEnabled: false }),
    );

    render(<RequestsTable {...baseProps} />);

    expect(
      screen.getByText(/Replay is not enabled on this deployment/i),
    ).toBeInTheDocument();
    // ReplayCell's replayEnabled:false branch renders a muted "—" placeholder
    // instead of a button at all — a mutation that kept rendering an
    // (enabled or disabled) button here would fail this assertion.
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });

  it("replayEnabled: true, bodyTruncated row -> button disabled with the truncation reason shown", () => {
    useInfiniteQuery.mockReturnValue(
      makeQueryResult({
        rows: [makeRow({ requestId: "req-truncated", bodyTruncated: true, hasBody: true })],
        replayEnabled: true,
      }),
    );

    render(<RequestsTable {...baseProps} />);

    expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
    expect(
      screen.getByText(
        /This request's captured body was truncated — the replay would not be a fair comparison/,
      ),
    ).toBeInTheDocument();
  });

  it("replayEnabled: true, !hasBody row -> button disabled with the retention-lapsed reason shown", () => {
    useInfiniteQuery.mockReturnValue(
      makeQueryResult({
        rows: [makeRow({ requestId: "req-nobody", bodyTruncated: false, hasBody: false })],
        replayEnabled: true,
      }),
    );

    render(<RequestsTable {...baseProps} />);

    expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
    expect(
      screen.getByText(/Past its retention period — the captured content has been deleted/),
    ).toBeInTheDocument();
  });

  it("replayEnabled: true, clean row -> button is enabled and no disabled-reason text is shown", () => {
    useInfiniteQuery.mockReturnValue(
      makeQueryResult({
        rows: [makeRow({ requestId: "req-clean", bodyTruncated: false, hasBody: true })],
        replayEnabled: true,
      }),
    );

    render(<RequestsTable {...baseProps} />);

    const button = screen.getByRole("button", { name: "Replay" });
    expect(button).toBeEnabled();
    expect(
      screen.queryByText(/truncated|retention period/i),
    ).not.toBeInTheDocument();
  });
});
