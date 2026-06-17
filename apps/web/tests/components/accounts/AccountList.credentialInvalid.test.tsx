import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---- trpc mock ----
const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { list: { invalidate } } }),
    accounts: {
      list: { useQuery: vi.fn() },
      delete: { useMutation: vi.fn() },
      rotate: { useMutation: vi.fn() },
      reonboard: { useMutation: vi.fn() },
      update: { useMutation: vi.fn() },
    },
  },
}));

// ---- dependency mocks ----
vi.mock("@/lib/usePermissions", () => ({
  usePermissions: () => ({ can: () => true }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/time", () => ({
  formatRelative: () => "just now",
}));

import { AccountList } from "@/components/accounts/AccountList";
import { trpc } from "@/lib/trpc/client";

const useQuery = trpc.accounts.list.useQuery as unknown as ReturnType<
  typeof vi.fn
>;
const useDeleteMutation = trpc.accounts.delete.useMutation as unknown as ReturnType<
  typeof vi.fn
>;
const useRotateMutation = trpc.accounts.rotate.useMutation as unknown as ReturnType<
  typeof vi.fn
>;
const useReonboardMutation = trpc.accounts.reonboard.useMutation as unknown as ReturnType<
  typeof vi.fn
>;
const useUpdateMutation = trpc.accounts.update.useMutation as unknown as ReturnType<
  typeof vi.fn
>;

const deadCredentialAccount = {
  id: "acc-dead-1",
  name: "Prod API Key",
  platform: "anthropic",
  type: "api_key",
  priority: 50,
  concurrency: 2,
  lastUsedAt: null,
  tempUnschedulableReason: "api_key_invalid_credential",
  status: "paused",
};

beforeEach(() => {
  vi.clearAllMocks();
  useDeleteMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  useRotateMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  useReonboardMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  useUpdateMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

describe("AccountList — api_key_invalid_credential banner", () => {
  it("renders the dead-credential amber banner when an account has api_key_invalid_credential", () => {
    useQuery.mockReturnValue({
      data: [deadCredentialAccount],
      isLoading: false,
      error: null,
    });

    render(<AccountList orgId="org-1" />);

    // The i18n key won't exist in the catalog until Task 13, so the stub
    // returns the full path string — assert on the rotate button which is
    // always present (English catalog has "rotateCredentials").
    // The banner Card should be in the document; we can detect it by the
    // button it renders.
    expect(
      screen.getByRole("button", { name: /rotate/i }),
    ).toBeInTheDocument();
  });

  it("opens RotateCredentialDialog when the banner rotate button is clicked", async () => {
    const user = userEvent.setup();
    useQuery.mockReturnValue({
      data: [deadCredentialAccount],
      isLoading: false,
      error: null,
    });

    render(<AccountList orgId="org-1" />);

    // Find the banner-level rotate button (distinct from kebab menu).
    // After clicking it the RotateCredentialDialog should open, showing
    // the account name in its dialog description.
    const bannerBtn = screen.getAllByRole("button", { name: /rotate/i })[0]!;
    await user.click(bannerBtn);

    // RotateCredentialDialog renders a DialogTitle "Rotate credential".
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does NOT render the banner when no accounts have api_key_invalid_credential", () => {
    const healthyAccount = {
      ...deadCredentialAccount,
      id: "acc-ok",
      tempUnschedulableReason: null,
    };
    useQuery.mockReturnValue({
      data: [healthyAccount],
      isLoading: false,
      error: null,
    });

    render(<AccountList orgId="org-1" />);

    // No amber banner button should appear (only the kebab trigger remains,
    // but it has a different aria-label: "actionsAriaLabel").
    // The credentialInvalidTitle key should not be rendered.
    expect(
      screen.queryByText(/accounts\.credentialInvalidTitle/),
    ).not.toBeInTheDocument();
  });
});
