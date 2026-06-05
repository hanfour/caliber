import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ConfirmDialogProvider,
  useConfirm,
} from "@/components/ui/confirm-dialog";

function Probe({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () =>
        onResult(await confirm({ description: "Delete X?", destructive: true }))
      }
    >
      trigger
    </button>
  );
}

function renderProbe(onResult: (v: boolean) => void) {
  return render(
    <ConfirmDialogProvider>
      <Probe onResult={onResult} />
    </ConfirmDialogProvider>,
  );
}

describe("useConfirm / ConfirmDialogProvider", () => {
  it("shows the description and resolves true when confirmed", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderProbe(onResult);

    await user.click(screen.getByText("trigger"));
    expect(await screen.findByText("Delete X?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("resolves false when cancelled", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderProbe(onResult);

    await user.click(screen.getByText("trigger"));
    await screen.findByText("Delete X?");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("resolves false when dismissed via Escape (no action fires)", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderProbe(onResult);

    await user.click(screen.getByText("trigger"));
    await screen.findByText("Delete X?");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("throws when useConfirm is used outside the provider", () => {
    function Bare() {
      useConfirm();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow(/ConfirmDialogProvider/);
    spy.mockRestore();
  });
});
