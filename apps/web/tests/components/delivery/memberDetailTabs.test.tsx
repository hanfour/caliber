import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "org-1", uid: "user-1" }),
}));

// Records every action an ancestor gates on, so we can assert the delivery
// tab BUTTON itself — not just its content — is wrapped in RequirePerm with
// the expected action. Passthrough: always renders children (self sees own
// tab, org_admin sees all — RBAC denial paths are RequirePerm's own tests).
const recordedActions: unknown[] = [];
vi.mock("@/components/RequirePerm", () => ({
  RequirePerm: ({
    action,
    children,
  }: {
    action: unknown;
    children: React.ReactNode;
  }) => {
    recordedActions.push(action);
    return <>{children}</>;
  },
}));

vi.mock("@/components/evaluator/ReportDetail", () => ({
  ReportDetail: () => <div data-testid="report-detail-marker" />,
}));

vi.mock("@/components/delivery/DeliveryDetail", () => ({
  DeliveryDetail: () => <div data-testid="delivery-detail-marker" />,
}));

const resolveIdentifierQuery = vi.fn();
const usersGetQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    organizations: {
      resolveIdentifier: {
        useQuery: (...a: unknown[]) => resolveIdentifierQuery(...a),
      },
    },
    users: {
      get: { useQuery: (...a: unknown[]) => usersGetQuery(...a) },
    },
  },
}));

import MemberDetailPage from "@/app/dashboard/organizations/[id]/members/[uid]/page";

describe("member detail tab strip", () => {
  beforeEach(() => {
    recordedActions.length = 0;
    resolveIdentifierQuery.mockReturnValue({
      data: { id: "org-1", name: "Acme", slug: "acme" },
    });
    usersGetQuery.mockReturnValue({
      data: { id: "user-1", name: "Steve", email: "steve@example.com" },
      isLoading: false,
    });
  });

  it("defaults to the evaluation tab", () => {
    render(<MemberDetailPage />);
    expect(screen.getByTestId("report-detail-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-detail-marker")).not.toBeInTheDocument();
  });

  it("swaps to the delivery tab when clicked, unmounting the evaluation tab", () => {
    render(<MemberDetailPage />);

    // The delivery tab button label reuses evaluator.delivery.title ("Delivery").
    fireEvent.click(screen.getByRole("button", { name: "Delivery" }));

    expect(screen.getByTestId("delivery-detail-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("report-detail-marker")).not.toBeInTheDocument();
  });

  it("swaps back to the evaluation tab when clicked", () => {
    render(<MemberDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delivery" }));
    fireEvent.click(screen.getByRole("button", { name: "Evaluation" }));

    expect(screen.getByTestId("report-detail-marker")).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-detail-marker")).not.toBeInTheDocument();
  });

  it("renders the delivery tab button and gates it with delivery.read_user for this org/member", () => {
    render(<MemberDetailPage />);

    expect(screen.getByRole("button", { name: "Delivery" })).toBeInTheDocument();
    expect(recordedActions).toContainEqual({
      type: "delivery.read_user",
      orgId: "org-1",
      targetUserId: "user-1",
    });
  });
});
