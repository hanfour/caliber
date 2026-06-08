import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ apiKeys: { listOwn: { invalidate } } }),
    apiKeys: { issueOwn: { useMutation: vi.fn() } },
  },
}));
import { ApiKeyCreateDialog } from "@/components/apiKeys/ApiKeyCreateDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.apiKeys.issueOwn.useMutation as unknown as ReturnType<typeof vi.fn>;

describe("ApiKeyCreateDialog routing_policy", () => {
  beforeEach(() => invalidate.mockReset());

  it("defaults to pool and passes 'pool' when unchanged", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({ raw: "ak_x", prefix: "ak_x" });
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<ApiKeyCreateDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Name"), "k1");
    await user.click(screen.getByRole("button", { name: "Generate key" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ name: "k1", routingPolicy: "pool" }));
  });

  it("passes the selected routingPolicy", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({ raw: "ak_x", prefix: "ak_x" });
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<ApiKeyCreateDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Name"), "k2");
    await user.selectOptions(screen.getByLabelText("Upstream routing"), "own");
    await user.click(screen.getByRole("button", { name: "Generate key" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ name: "k2", routingPolicy: "own" }));
  });
});
