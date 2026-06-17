import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { list: { invalidate } } }),
    accounts: { update: { useMutation: vi.fn() } },
  },
}));
import { EditAccountDialog } from "@/components/accounts/EditAccountDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.accounts.update.useMutation as unknown as ReturnType<
  typeof vi.fn
>;

const account = {
  id: "a1",
  name: "Prod key",
  priority: 30,
  concurrency: 5,
  schedulable: true,
};

describe("EditAccountDialog", () => {
  it("renders the dialog pre-filled with the account's values", () => {
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(
      <EditAccountDialog account={account} orgId="org-1" onClose={() => {}} />,
    );
    expect(screen.getByText("Edit account")).toBeInTheDocument();
    expect(screen.getByText(/Prod key/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Prod key");
    expect(screen.getByLabelText("Priority")).toHaveValue(30);
    expect(screen.getByLabelText("Concurrency")).toHaveValue(5);
    expect(screen.getByLabelText("Schedulable")).toBeChecked();
  });

  it("does not render when account is null", () => {
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(
      <EditAccountDialog account={null} orgId="org-1" onClose={() => {}} />,
    );
    expect(screen.queryByText("Edit account")).not.toBeInTheDocument();
  });

  it("calls accounts.update with the edited fields on submit", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({});
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(
      <EditAccountDialog account={account} orgId="org-1" onClose={() => {}} />,
    );

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed key");

    const priority = screen.getByLabelText("Priority");
    await user.clear(priority);
    await user.type(priority, "10");

    // Toggle schedulable off.
    await user.click(screen.getByLabelText("Schedulable"));

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        id: "a1",
        name: "Renamed key",
        priority: 10,
        concurrency: 5,
        schedulable: false,
      }),
    );
  });

  it("calls onClose when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    render(
      <EditAccountDialog account={account} orgId="org-1" onClose={onClose} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
