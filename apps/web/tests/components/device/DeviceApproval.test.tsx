import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = vi.fn();
let searchParamsCode = "ABCD-1234";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/device",
  useSearchParams: () => ({
    get: (key: string) => (key === "code" ? searchParamsCode : null),
    toString: () => (searchParamsCode ? `code=${searchParamsCode}` : ""),
  }),
}));

const sessionQuery = vi.fn();
const lookupQuery = vi.fn();
const approveMutate = vi.fn();
const denyMutate = vi.fn();
let approveOnSuccess: (() => void) | undefined;
let approveOnError: (() => void) | undefined;
let denyOnSuccess: (() => void) | undefined;
let denyOnError: (() => void) | undefined;
let approveShouldFail = false;
let denyShouldFail = false;

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    me: { session: { useQuery: (...a: unknown[]) => sessionQuery(...a) } },
    devices: {
      deviceAuth: {
        lookup: { useQuery: (...a: unknown[]) => lookupQuery(...a) },
        approve: {
          useMutation: (opts: { onSuccess?: () => void; onError?: () => void }) => {
            approveOnSuccess = opts?.onSuccess;
            approveOnError = opts?.onError;
            return {
              mutate: (v: unknown) => {
                approveMutate(v);
                if (approveShouldFail) {
                  approveOnError?.();
                } else {
                  approveOnSuccess?.();
                }
              },
              isPending: false,
            };
          },
        },
        deny: {
          useMutation: (opts: { onSuccess?: () => void; onError?: () => void }) => {
            denyOnSuccess = opts?.onSuccess;
            denyOnError = opts?.onError;
            return {
              mutate: (v: unknown) => {
                denyMutate(v);
                if (denyShouldFail) {
                  denyOnError?.();
                } else {
                  denyOnSuccess?.();
                }
              },
              isPending: false,
            };
          },
        },
      },
    },
  },
}));

import { DeviceApproval } from "@/components/device/DeviceApproval";

describe("DeviceApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParamsCode = "ABCD-1234";
    approveShouldFail = false;
    denyShouldFail = false;
  });

  it("shows a sign-in prompt when the user is signed out", () => {
    sessionQuery.mockReturnValue({ data: null, isLoading: false });
    lookupQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<DeviceApproval />);
    expect(screen.getByText("Please sign in to authorize this device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("navigates to sign-in with a callbackUrl when the sign-in button is clicked", async () => {
    // sign-in/page.tsx only reads `callbackUrl` (not `returnTo`) and passes
    // it to signIn(..., { redirectTo }), so that's the param that actually
    // round-trips back to /device?code=... after auth.
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: null, isLoading: false });
    lookupQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0]).toMatch(/^\/sign-in\?callbackUrl=/);
  });

  // Anti-phishing (Security M1): the ?code= link is attacker-shareable and
  // unauthenticated (POST /v1/device-auth/start requires no auth), so a
  // victim must take an explicit action before we ever look up — and thus
  // display — attacker-controlled hostname/os. Auto-firing the lookup on
  // mount removed that confirmation step; this is the RED-first regression
  // guard for restoring it.
  it("pre-fills the code from ?code= but does NOT auto-fire the lookup on mount", () => {
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    render(<DeviceApproval />);

    expect(screen.getByLabelText("Device code")).toHaveValue("ABCD-1234");
    expect(lookupQuery).toHaveBeenCalledWith({ userCode: "ABCD-1234" }, { enabled: false });
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("only fires the lookup after the user clicks Continue", async () => {
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: { hostname: "hanfour-mac", os: "macOS 15.1", agentVersion: "0.1.0" },
      isLoading: false,
      error: null,
    });
    render(<DeviceApproval />);

    expect(lookupQuery).toHaveBeenLastCalledWith({ userCode: "ABCD-1234" }, { enabled: false });

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(lookupQuery).toHaveBeenLastCalledWith({ userCode: "ABCD-1234" }, { enabled: true });
    expect(screen.getByRole("button", { name: "Authorize" })).toBeInTheDocument();
  });

  it("renders the consent body, the phishing warning, and the Authorize button for a looked-up pending flow", async () => {
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: { hostname: "hanfour-mac", os: "macOS 15.1", agentVersion: "0.1.0" },
      isLoading: false,
      error: null,
    });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/What will be recorded/)).toBeInTheDocument();
    expect(
      screen.getByText(/Your full Claude Code and Codex conversations/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only approve if you just ran `caliber login` on THIS device/),
    ).toBeInTheDocument();
    expect(screen.getByText(/self-reported by the requesting machine/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Authorize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("calls the approve mutation with the userCode when Authorize is clicked, then shows the approved message", async () => {
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: { hostname: "hanfour-mac", os: "macOS 15.1" },
      isLoading: false,
      error: null,
    });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    expect(approveMutate).toHaveBeenCalledWith({ userCode: "ABCD-1234" });
    await waitFor(() =>
      expect(
        screen.getByText("Device authorized. Return to your terminal — it will finish setup automatically."),
      ).toBeInTheDocument(),
    );
  });

  it("calls the deny mutation with the userCode when Deny is clicked, then shows the denied message", async () => {
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: { hostname: "hanfour-mac", os: "macOS 15.1" },
      isLoading: false,
      error: null,
    });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(denyMutate).toHaveBeenCalledWith({ userCode: "ABCD-1234" });
    await waitFor(() =>
      expect(screen.getByText("Request denied.")).toBeInTheDocument(),
    );
  });

  it("shows the not-found/expired message when the approve mutation fails", async () => {
    const user = userEvent.setup();
    approveShouldFail = true;
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: { hostname: "hanfour-mac", os: "macOS 15.1" },
      isLoading: false,
      error: null,
    });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    expect(approveMutate).toHaveBeenCalledWith({ userCode: "ABCD-1234" });
    await waitFor(() =>
      expect(
        screen.getByText("That code is invalid or has expired. Run `caliber login` again."),
      ).toBeInTheDocument(),
    );
  });

  it("shows the not-found message when the lookup errors with NOT_FOUND", async () => {
    const user = userEvent.setup();
    sessionQuery.mockReturnValue({ data: { user: { id: "u1" } }, isLoading: false });
    lookupQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { data: { code: "NOT_FOUND" } },
    });
    render(<DeviceApproval />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByText("That code is invalid or has expired. Run `caliber login` again."),
    ).toBeInTheDocument();
  });
});
