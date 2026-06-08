import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}));

const listOwnQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      accounts: {
        listOwn: { invalidate: vi.fn() },
      },
    }),
    accounts: {
      listOwn: { useQuery: (...a: unknown[]) => listOwnQuery(...a) },
      deleteOwn: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }) },
      registerOwn: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }) },
      updateOwn: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }) },
      rotateOwn: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }) },
    },
  },
}));
import { UpstreamOwnList } from "@/components/upstreams/UpstreamOwnList";

const baseRow = {
  id: "a1", name: "My key", platform: "anthropic", type: "api_key", priority: 50,
  schedulable: true, status: "active", rateLimitedAt: null, rateLimitResetAt: null,
  overloadUntil: null, tempUnschedulableUntil: null, expiresAt: null, errorMessage: null,
  createdAt: "2026-06-08T00:00:00Z", lastUsedAt: null,
};

describe("UpstreamOwnList", () => {
  it("renders the empty-state hint when there are no upstreams", () => {
    listOwnQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<UpstreamOwnList />);
    expect(screen.getByText("You haven't registered any upstream credentials yet.")).toBeInTheDocument();
  });
  it("renders a row and shows the Rotate action for an api_key upstream", () => {
    listOwnQuery.mockReturnValue({ data: [baseRow], isLoading: false, error: null });
    render(<UpstreamOwnList />);
    expect(screen.getByText("My key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate credential for My key" })).toBeInTheDocument();
  });
  it("hides the Rotate action for a non-api_key (e.g. future oauth) upstream", () => {
    listOwnQuery.mockReturnValue({ data: [{ ...baseRow, type: "oauth" }], isLoading: false, error: null });
    render(<UpstreamOwnList />);
    expect(screen.queryByRole("button", { name: "Rotate credential for My key" })).not.toBeInTheDocument();
  });
});
