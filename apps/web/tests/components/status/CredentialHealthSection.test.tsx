import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const listOwnQuery = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    accounts: { listOwn: { useQuery: (...a: unknown[]) => listOwnQuery(...a) } },
  },
}));
import { CredentialHealthSection } from "@/components/status/CredentialHealthSection";

const baseRow = {
  id: "a1", name: "My key", platform: "anthropic", type: "api_key", priority: 50,
  schedulable: true, status: "active", rateLimitedAt: null, rateLimitResetAt: null,
  overloadUntil: null, tempUnschedulableUntil: null, expiresAt: null, errorMessage: null,
  createdAt: "2026-06-08T00:00:00Z", lastUsedAt: null,
};

describe("CredentialHealthSection", () => {
  it("shows the empty hint with a manage-upstreams link when there are none", () => {
    listOwnQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<CredentialHealthSection />);
    expect(screen.getByText("You haven't registered any upstream credentials yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage upstreams" })).toHaveAttribute("href", "/dashboard/upstreams");
  });

  it("renders a healthy upstream row with an Active badge", () => {
    listOwnQuery.mockReturnValue({ data: [baseRow], isLoading: false, error: null });
    render(<CredentialHealthSection />);
    expect(screen.getByText("My key")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders Expired status + expiry cell for an expired OAuth upstream", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    listOwnQuery.mockReturnValue({
      data: [{ ...baseRow, type: "oauth", expiresAt: past }],
      isLoading: false, error: null,
    });
    render(<CredentialHealthSection />);
    // deriveAccountStatus → "expired" → common.expired = "Expired" (badge),
    // ExpiryCountdown → "Expired" too. Both present → at least 2 matches.
    expect(screen.getAllByText("Expired").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the section error message when the query errors", () => {
    listOwnQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" } });
    render(<CredentialHealthSection />);
    expect(screen.getByText("Couldn't load credential health. Please try again.")).toBeInTheDocument();
  });

  it("shows the loading indicator while the query is in flight", () => {
    listOwnQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<CredentialHealthSection />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
