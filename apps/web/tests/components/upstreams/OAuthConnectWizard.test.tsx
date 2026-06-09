import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const initiateMutate = vi.fn();
const completeMutate = vi.fn();
const openSpy = vi.fn();
// When set, initiateOAuth.mutate fires onError(this) instead of onSuccess.
let initiateError: { data?: { code?: string }; message: string } | null = null;
vi.stubGlobal("open", openSpy);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    accounts: {
      initiateOAuth: { useMutation: (opts: any) => ({ mutate: (v: any) => { initiateMutate(v); if (initiateError) { opts.onError?.(initiateError); } else { opts.onSuccess?.({ authUrl: "https://auth.openai.com/x", flowId: "FLOW22charstate0000000" }); } }, isPending: false }) },
      completeOAuth: { useMutation: (opts: any) => ({ mutate: (v: any) => { completeMutate(v); opts.onSuccess?.({ id: "a1" }); }, isPending: false }) },
    },
  },
}));
import { toast } from "sonner";
import { OAuthConnectWizard } from "@/components/upstreams/OAuthConnectWizard";

describe("OAuthConnectWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initiateError = null;
  });

  it("Connect calls initiateOAuth, opens the auth URL, then reveals the paste field", () => {
    render(<OAuthConnectWizard platform="openai" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(initiateMutate).toHaveBeenCalledWith({ platform: "openai", targetUpstreamId: undefined });
    expect(openSpy).toHaveBeenCalledWith("https://auth.openai.com/x", "_blank", "noopener,noreferrer");
    expect(screen.getByLabelText("Authorization code")).toBeInTheDocument();
  });

  it("Submit calls completeOAuth with flowId + pastedValue then onDone", async () => {
    const onDone = vi.fn();
    render(<OAuthConnectWizard platform="openai" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.change(screen.getByLabelText("Authorization code"), { target: { value: "http://localhost:1455/auth/callback?code=C&state=FLOW22charstate0000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(completeMutate).toHaveBeenCalledWith({ flowId: "FLOW22charstate0000000", pastedValue: "http://localhost:1455/auth/callback?code=C&state=FLOW22charstate0000000" });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("passes targetUpstreamId through for re-authorize", () => {
    render(<OAuthConnectWizard platform="anthropic" targetUpstreamId="up1" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(initiateMutate).toHaveBeenCalledWith({ platform: "anthropic", targetUpstreamId: "up1" });
  });

  it("shows the anthropic-disabled message when initiate errors with NOT_FOUND", () => {
    initiateError = { data: { code: "NOT_FOUND" }, message: "boom" };
    render(<OAuthConnectWizard platform="anthropic" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(toast.error).toHaveBeenCalledWith("Anthropic OAuth is not enabled.");
    // stays on the Connect step (no paste field revealed)
    expect(screen.queryByLabelText("Authorization code")).not.toBeInTheDocument();
  });
});
