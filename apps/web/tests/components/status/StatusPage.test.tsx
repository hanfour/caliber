import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const invalidateHealth = vi.fn();
const invalidateError = vi.fn();
const invalidateSummary = vi.fn();
const invalidateList = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      accounts: { listOwn: { invalidate: invalidateHealth } },
      usage: {
        errorSummary: { invalidate: invalidateError },
        summary: { invalidate: invalidateSummary },
        list: { invalidate: invalidateList },
      },
    }),
  },
}));
vi.mock("@/components/status/CredentialHealthSection", () => ({
  CredentialHealthSection: () => <div data-testid="health-section" />,
}));
vi.mock("@/components/status/ErrorRateSection", () => ({
  ErrorRateSection: () => <div data-testid="error-section" />,
}));
vi.mock("@/components/status/RecentActivitySection", () => ({
  RecentActivitySection: () => <div data-testid="activity-section" />,
}));
vi.mock("@/components/status/ByKeySection", () => ({
  ByKeySection: () => <div data-testid="bykey-section" />,
}));
import StatusPage from "@/app/dashboard/status/page";

describe("StatusPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all sections", () => {
    render(<StatusPage />);
    expect(screen.getByTestId("health-section")).toBeInTheDocument();
    expect(screen.getByTestId("error-section")).toBeInTheDocument();
    expect(screen.getByTestId("bykey-section")).toBeInTheDocument();
    expect(screen.getByTestId("activity-section")).toBeInTheDocument();
  });

  it("invalidates all four queries when Refresh is clicked", () => {
    render(<StatusPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(invalidateHealth).toHaveBeenCalledTimes(1);
    expect(invalidateError).toHaveBeenCalledTimes(1);
    expect(invalidateSummary).toHaveBeenCalledTimes(1);
    expect(invalidateList).toHaveBeenCalledTimes(1);
  });
});
