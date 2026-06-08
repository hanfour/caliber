import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { listOwn: { invalidate: vi.fn() } } }),
    accounts: { updateOwn: { useMutation: vi.fn() } },
  },
}));
import { UpstreamEditDialog } from "@/components/upstreams/UpstreamEditDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.accounts.updateOwn.useMutation as unknown as ReturnType<typeof vi.fn>;

const row = { id: "a1", name: "Old", schedulable: true, priority: 50 };

describe("UpstreamEditDialog", () => {
  it("submits priority as a number (valueAsNumber/coerce), not a string", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({});
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<UpstreamEditDialog open account={row} onOpenChange={() => {}} />);
    const pri = screen.getByLabelText(/Priority/);
    await user.clear(pri);
    await user.type(pri, "10");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const arg = mutateAsync.mock.calls[0][0];
      expect(arg.id).toBe("a1");
      expect(arg.priority).toBe(10);
      expect(typeof arg.priority).toBe("number");
    });
  });
});
