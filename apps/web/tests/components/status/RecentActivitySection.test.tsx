import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const summaryQuery = vi.fn();
const listQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    usage: {
      summary: { useQuery: (...a: unknown[]) => summaryQuery(...a) },
      list: { useQuery: (...a: unknown[]) => listQuery(...a) },
    },
  },
}));
import { RecentActivitySection } from "@/components/status/RecentActivitySection";

const summaryData = {
  totalRequests: 48, totalCostUsd: "0.1200000000", totalInputTokens: 0,
  totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, byModel: [],
};
const listRow = {
  id: "u1", requestId: "r1", userId: "me", apiKeyId: "k1", accountId: "ac1",
  orgId: "o1", teamId: null, requestedModel: "claude-sonnet-4-5", upstreamModel: "x",
  platform: "anthropic", surface: "messages", inputTokens: 10, outputTokens: 20,
  cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: "0.0030000000", stream: false,
  statusCode: 200, durationMs: 1400, firstTokenMs: null, bufferReleasedAtMs: null,
  upstreamRetries: 0, createdAt: "2026-06-08T14:02:00Z", notionalCost: "0.1500000000",
};

describe("RecentActivitySection", () => {
  it("shows the empty state when there is no usage", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: { items: [], page: 1, pageSize: 10, totalCount: 0 }, isLoading: false, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("No usage recorded yet.")).toBeInTheDocument();
  });

  it("renders a recent request row with its model and status code", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: { items: [listRow], page: 1, pageSize: 10, totalCount: 1 }, isLoading: false, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
    // Cost rendered via formatUsd (Decimal-based), not the raw numeric(20,10)
    // string: summary line shows "$0.12", row cost cell shows "$0.00".
    expect(screen.getByText("48 requests · $0.12")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument(); // actual cost (OAuth)
    expect(screen.getByText("$0.15")).toBeInTheDocument(); // est. cost column
  });

  it("renders the section error message when the list query errors", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<RecentActivitySection />);
    expect(screen.getByText("Couldn't load recent activity. Please try again.")).toBeInTheDocument();
  });

  it("shows the loading indicator while the list query is in flight", () => {
    summaryQuery.mockReturnValue({ data: summaryData, isLoading: false, error: null });
    listQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows a summary error message (not the bar) when the summary query errors, while the list still renders", () => {
    summaryQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    listQuery.mockReturnValue({ data: { items: [listRow], page: 1, pageSize: 10, totalCount: 1 }, isLoading: false, error: null });
    render(<RecentActivitySection />);
    expect(screen.getByText("Couldn't load the summary.")).toBeInTheDocument();
    // The list/table is independent and still renders.
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
  });
});
