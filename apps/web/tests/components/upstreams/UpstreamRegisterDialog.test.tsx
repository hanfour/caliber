import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invalidate = vi.fn();
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ accounts: { listOwn: { invalidate } } }),
    accounts: { registerOwn: { useMutation: vi.fn() } },
  },
}));

import { UpstreamRegisterDialog } from "@/components/upstreams/UpstreamRegisterDialog";
import { trpc } from "@/lib/trpc/client";
const useMutation = trpc.accounts.registerOwn.useMutation as unknown as ReturnType<typeof vi.fn>;

describe("UpstreamRegisterDialog", () => {
  beforeEach(() => { invalidate.mockReset(); });

  it("submits name + platform + credentials with type api_key injected", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({ id: "a1" });
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<UpstreamRegisterDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Name"), "My key");
    await user.type(screen.getByLabelText("API key"), "sk-ant-xyz");
    await user.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ name: "My key", platform: "anthropic", type: "api_key", credentials: "sk-ant-xyz" }));
  });

  it("blocks submit when credentials is empty", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn();
    useMutation.mockReturnValue({ mutateAsync, isPending: false });
    render(<UpstreamRegisterDialog open onOpenChange={() => {}} />);
    await user.type(screen.getByLabelText("Name"), "My key");
    await user.click(screen.getByRole("button", { name: "Register" }));
    await waitFor(() => expect(screen.getByText(/credentials are required/i)).toBeInTheDocument());
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
