import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// DeliveryScoreCell has its own dedicated test suite (DeliveryScoreCell.test.tsx)
// covering all its internal states/tRPC plumbing. Here we only need to prove
// the leaderboard mounts exactly one cell per row with the right props, so we
// stub it out with a marker per the brief's guidance.
vi.mock("@/components/delivery/DeliveryScoreCell", () => ({
  DeliveryScoreCell: ({ orgId, userId }: { orgId: string; userId: string }) => (
    <div data-testid="delivery-score-cell-marker" data-org-id={orgId} data-user-id={userId} />
  ),
}));

const getSettingsQuery = vi.fn();
const getTeamQuery = vi.fn();

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    contentCapture: { getSettings: { useQuery: (...a: unknown[]) => getSettingsQuery(...a) } },
    reports: { getTeam: { useQuery: (...a: unknown[]) => getTeamQuery(...a) } },
  },
}));

import { TeamLeaderboard } from "@/components/evaluator/TeamLeaderboard";

// ── Fixtures ────────────────────────────────────────────────────────────────

const members = [
  { id: "user-1", name: "Alice", email: "alice@example.com" },
  { id: "user-2", name: "Bob", email: "bob@example.com" },
];

const currentReports = [
  { userId: "user-1", totalScore: "92.0" },
  { userId: "user-2", totalScore: "70.0" },
];

const prevReports = [
  { userId: "user-1", totalScore: "80.0" },
  { userId: "user-2", totalScore: "70.0" },
];

/** reports.getTeam.useQuery is called twice per render: current window, then
 * previous window. A single non-interactive render only fires each hook
 * once, so a call-order counter is sufficient to hand back the right fixture
 * to each call without needing to inspect the (real, Date.now()-derived)
 * range argument. */
function setupTeamQueries(current: unknown, prev: unknown) {
  let callCount = 0;
  getTeamQuery.mockImplementation(() => {
    callCount += 1;
    const data = callCount === 1 ? current : prev;
    return { data, isLoading: false };
  });
}

beforeEach(() => {
  getSettingsQuery.mockReset();
  getTeamQuery.mockReset();
});

describe("TeamLeaderboard", () => {
  it("renders a loading card while any query is pending", () => {
    getSettingsQuery.mockReturnValue({ data: undefined, isLoading: true });
    getTeamQuery.mockReturnValue({ data: undefined, isLoading: true });

    render(<TeamLeaderboard orgId="org-1" teamId="team-1" members={members} />);

    expect(screen.getByText("Loading member scores…")).toBeInTheDocument();
  });

  it("renders the new Delivery header between Score and Trend, and one marker per row", () => {
    getSettingsQuery.mockReturnValue({ data: { leaderboardEnabled: false }, isLoading: false });
    setupTeamQueries(currentReports, prevReports);

    render(<TeamLeaderboard orgId="org-1" teamId="team-1" members={members} />);

    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["Member", "Score", "Delivery", "Trend"]);

    const markers = screen.getAllByTestId("delivery-score-cell-marker");
    expect(markers).toHaveLength(2);
    const userIds = markers.map((m) => m.getAttribute("data-user-id")).sort();
    expect(userIds).toEqual(["user-1", "user-2"]);
    for (const marker of markers) {
      expect(marker.getAttribute("data-org-id")).toBe("org-1");
    }
  });

  it("keeps the ranked header layout (with # column) when the leaderboard is enabled", () => {
    getSettingsQuery.mockReturnValue({ data: { leaderboardEnabled: true }, isLoading: false });
    setupTeamQueries(currentReports, prevReports);

    render(<TeamLeaderboard orgId="org-1" teamId="team-1" members={members} />);

    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["#", "Member", "Score", "Delivery", "Trend"]);
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  });

  it("still renders existing member/score/trend content unaffected by the new column", () => {
    getSettingsQuery.mockReturnValue({ data: { leaderboardEnabled: false }, isLoading: false });
    setupTeamQueries(currentReports, prevReports);

    render(<TeamLeaderboard orgId="org-1" teamId="team-1" members={members} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("92.0")).toBeInTheDocument();
    expect(screen.getByText("70.0")).toBeInTheDocument();
    expect(screen.getByText("Member Scores")).toBeInTheDocument();
  });

  it("renders the empty state (no rows) without mounting any delivery cell", () => {
    getSettingsQuery.mockReturnValue({ data: { leaderboardEnabled: false }, isLoading: false });
    setupTeamQueries([], []);

    render(<TeamLeaderboard orgId="org-1" teamId="team-1" members={members} />);

    expect(screen.getByText("No individual reports found for this period.")).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-score-cell-marker")).not.toBeInTheDocument();
  });
});
