import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const listActivityQuery = vi.fn();

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    githubDelivery: {
      listActivity: { useQuery: (...a: unknown[]) => listActivityQuery(...a) },
    },
  },
}));

import { DeliveryActivityList } from "@/components/delivery/DeliveryActivityList";

const baseArgs = { orgId: "org-1", userId: "u-1", from: "2026-06-10T00:00:00.000Z", to: "2026-07-10T00:00:00.000Z" };

describe("DeliveryActivityList", () => {
  beforeEach(() => {
    listActivityQuery.mockReset();
  });

  it("shows a skeleton line while loading", () => {
    listActivityQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = render(<DeliveryActivityList {...baseArgs} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders nothing on a NOT_FOUND error", () => {
    listActivityQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "not found", data: { code: "NOT_FOUND" } },
    });
    const { container } = render(<DeliveryActivityList {...baseArgs} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the raw error message for a non-NOT_FOUND error", () => {
    listActivityQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
    });
    render(<DeliveryActivityList {...baseArgs} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("shows the noLinkedAccount line when ghUserId is null", () => {
    listActivityQuery.mockReturnValue({
      data: { ghUserId: null, pulls: [], issues: [], reviews: [] },
      isLoading: false,
      error: null,
    });
    render(<DeliveryActivityList {...baseArgs} />);
    expect(screen.getByText("No linked GitHub account.")).toBeInTheDocument();
  });

  it("shows the noActivity line when all three lists are empty", () => {
    listActivityQuery.mockReturnValue({
      data: { ghUserId: 123, pulls: [], issues: [], reviews: [] },
      isLoading: false,
      error: null,
    });
    render(<DeliveryActivityList {...baseArgs} />);
    expect(screen.getByText("No delivery activity in this window.")).toBeInTheDocument();
  });

  it("renders the three section headings with counts and a working PR link href", () => {
    listActivityQuery.mockReturnValue({
      data: {
        ghUserId: 123,
        pulls: [
          {
            repoFullName: "caliber/web",
            number: 42,
            title: "Add delivery activity list",
            htmlUrl: "https://github.com/caliber/web/pull/42",
            state: "closed",
            ghCreatedAt: "2026-06-15T00:00:00.000Z",
            mergedAt: "2026-06-20T00:00:00.000Z",
          },
        ],
        issues: [
          {
            repoFullName: "caliber/web",
            number: 10,
            title: "Fix flaky test",
            htmlUrl: "https://github.com/caliber/web/issues/10",
            state: "closed",
            ghCreatedAt: "2026-06-01T00:00:00.000Z",
            closedAt: "2026-06-05T00:00:00.000Z",
          },
        ],
        reviews: [
          {
            repoFullName: "caliber/web",
            prGhNodeId: "PR_kwabc",
            state: "APPROVED",
            submittedAt: "2026-06-18T00:00:00.000Z",
          },
        ],
      },
      isLoading: false,
      error: null,
    });
    render(<DeliveryActivityList {...baseArgs} />);

    expect(listActivityQuery).toHaveBeenCalledWith(baseArgs);

    expect(screen.getByText("Pull requests (1)")).toBeInTheDocument();
    expect(screen.getByText("Issues (1)")).toBeInTheDocument();
    expect(screen.getByText("Reviews (1)")).toBeInTheDocument();

    const prLink = screen.getByRole("link", { name: /Add delivery activity list/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/caliber/web/pull/42");
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(prLink).toHaveAttribute("rel", "noopener noreferrer");

    // Reviews lack a PR number server-side, so the row renders `state · date`
    // only (no repo#number).
    expect(screen.getByText(/APPROVED ·/)).toBeInTheDocument();
  });
});
