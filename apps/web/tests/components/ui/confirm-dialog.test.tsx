import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("resolves false (no hang) if the provider unmounts while pending", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    const { unmount } = renderProbe(onResult);

    await user.click(screen.getByText("trigger"));
    await screen.findByText("Delete X?");
    // Dialog is open and the confirm() promise is still pending.
    expect(onResult).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it("cancels a pending prompt (resolves false) when confirm() is called again", async () => {
    // The modal blocks page clicks while open, so a second prompt can only be
    // raised programmatically — capture confirm() and drive it directly to
    // exercise the re-entrancy guard.
    const user = userEvent.setup();
    let confirmFn: ((o: { description: string }) => Promise<boolean>) | null =
      null;
    function Capture() {
      confirmFn = useConfirm();
      return null;
    }
    render(
      <ConfirmDialogProvider>
        <Capture />
      </ConfirmDialogProvider>,
    );

    const first = vi.fn();
    const second = vi.fn();
    await act(async () => {
      confirmFn!({ description: "First?" }).then(first);
    });
    await screen.findByText("First?");

    await act(async () => {
      confirmFn!({ description: "Second?" }).then(second);
    });
    // The first promise is settled as cancelled; the second prompt is shown.
    await waitFor(() => expect(first).toHaveBeenCalledWith(false));
    expect(await screen.findByText("Second?")).toBeInTheDocument();
    expect(second).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(second).toHaveBeenCalledWith(true));
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
