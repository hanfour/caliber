import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { listOwn: { invalidate: vi.fn() } } }),
    accounts: { rotateOwn: { useMutation: vi.fn() } },
  },
}));
import { UpstreamRotateDialog } from "@/components/upstreams/UpstreamRotateDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.accounts.rotateOwn.useMutation as unknown as ReturnType<typeof vi.fn>;

describe("UpstreamRotateDialog", () => {
  it("submits id + new credentials", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({});
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<UpstreamRotateDialog open account={{ id: "a1", name: "K" }} onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("New API key"), "sk-ant-new");
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ id: "a1", credentials: "sk-ant-new" }));
  });
});
