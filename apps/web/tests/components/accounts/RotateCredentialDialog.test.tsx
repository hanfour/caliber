import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { list: { invalidate } } }),
    accounts: { rotate: { useMutation: vi.fn() } },
  },
}));
import { RotateCredentialDialog } from "@/components/accounts/RotateCredentialDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.accounts.rotate.useMutation as unknown as ReturnType<
  typeof vi.fn
>;

describe("RotateCredentialDialog", () => {
  it("renders the dialog when an account is provided", () => {
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(
      <RotateCredentialDialog
        account={{ id: "a1", name: "Prod key" }}
        orgId="org-1"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Rotate credential")).toBeInTheDocument();
    expect(screen.getByText(/Prod key/)).toBeInTheDocument();
  });

  it("does not render when account is null", () => {
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(
      <RotateCredentialDialog account={null} orgId="org-1" onClose={() => {}} />,
    );
    expect(screen.queryByText("Rotate credential")).not.toBeInTheDocument();
  });

  it("does not call the mutation when credentials are empty", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({});
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(
      <RotateCredentialDialog
        account={{ id: "a1", name: "Prod key" }}
        orgId="org-1"
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() =>
      expect(screen.getByText("New credential")).toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("calls accounts.rotate with id + credentials on submit", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({});
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(
      <RotateCredentialDialog
        account={{ id: "a1", name: "Prod key" }}
        orgId="org-1"
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText("New credential"), "sk-ant-new");
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        id: "a1",
        credentials: "sk-ant-new",
      }),
    );
  });
});
