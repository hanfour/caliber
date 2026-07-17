import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Mocks (hoisted above the component import) ───────────────────────────────

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const getConnectionQuery = vi.fn();
const invalidateConnection = vi.fn();

const setConnectionMutateAsync = vi.fn();
let setConnectionOptions: {
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (e: unknown) => void;
} = {};

const syncNowMutate = vi.fn();
let syncNowOptions: {
  onSuccess?: () => void;
  onError?: (e: unknown) => void;
} = {};

const deleteConnectionMutate = vi.fn();
let deleteConnectionOptions: {
  onSuccess?: () => void;
  onError?: (e: unknown) => void;
} = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      githubDelivery: { getConnection: { invalidate: invalidateConnection } },
    }),
    githubDelivery: {
      getConnection: { useQuery: (...a: unknown[]) => getConnectionQuery(...a) },
      setConnection: {
        useMutation: (opts: typeof setConnectionOptions) => {
          setConnectionOptions = opts ?? {};
          return { mutateAsync: setConnectionMutateAsync, isPending: false };
        },
      },
      syncNow: {
        useMutation: (opts: typeof syncNowOptions) => {
          syncNowOptions = opts ?? {};
          return { mutate: syncNowMutate, isPending: false };
        },
      },
      deleteConnection: {
        useMutation: (opts: typeof deleteConnectionOptions) => {
          deleteConnectionOptions = opts ?? {};
          return { mutate: deleteConnectionMutate, isPending: false };
        },
      },
    },
  },
}));

import { GithubConnectionSettings } from "@/components/delivery/GithubConnectionSettings";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A decoy full-token-shaped string. The real `getConnection` endpoint never
// selects/returns the plaintext token (see apps/api's `getConnection` select
// map — only `tokenLast4`), but this guards against a future regression that
// accidentally widens the select and lets the component render it verbatim.
const DECOY_FULL_TOKEN = "github_pat_11AABBCCDDsecretvalue1234567890zzzz";

const connectedFixture = {
  ownerLogin: "acme",
  tokenLast4: "ab12",
  repoAllowlist: ["acme/web", "acme/api"],
  deliveryEnabled: true,
  status: "ok",
  lastSyncAt: "2026-07-10T00:00:00.000Z",
  lastSyncError: null,
  // Not part of the real API response shape — present only so the "full
  // token string absent from DOM" assertion has something to look for.
  token: DECOY_FULL_TOKEN,
};

describe("GithubConnectionSettings", () => {
  beforeEach(() => {
    getConnectionQuery.mockReset();
    setConnectionMutateAsync.mockReset();
    syncNowMutate.mockReset();
    deleteConnectionMutate.mockReset();
    invalidateConnection.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    setConnectionOptions = {};
    syncNowOptions = {};
    deleteConnectionOptions = {};
  });

  it("shows the noConnection message and the connect form when there is no connection", () => {
    getConnectionQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<GithubConnectionSettings orgId="org-1" />);

    expect(
      screen.getByText(
        "No GitHub connection yet — add a fine-grained PAT to start syncing delivery activity.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Owner")).toBeInTheDocument();
    expect(screen.getByLabelText("Fine-grained PAT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save connection" })).toBeInTheDocument();
  });

  it("shows the notEnabled card on a NOT_FOUND error and hides the form", () => {
    getConnectionQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "not found", data: { code: "NOT_FOUND" } },
    });
    render(<GithubConnectionSettings orgId="org-1" />);

    expect(
      screen.getByText("GitHub delivery integration is not enabled for this workspace."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Owner")).not.toBeInTheDocument();
  });

  it("shows the raw error message for a non-NOT_FOUND error", () => {
    getConnectionQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
    });
    render(<GithubConnectionSettings orgId="org-1" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders the connected card with a masked token, the status pill, and never the full token", () => {
    getConnectionQuery.mockReturnValue({
      data: connectedFixture,
      isLoading: false,
      error: null,
    });
    render(<GithubConnectionSettings orgId="org-1" />);

    expect(screen.getByText("••••ab12")).toBeInTheDocument();
    expect(screen.queryByText(DECOY_FULL_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText(/github_pat_11AABBCC/)).not.toBeInTheDocument();

    // Status pill (status.ok = "OK")
    expect(screen.getByText("OK")).toBeInTheDocument();

    // Repo allowlist renders as a comma line, not the "all repos" fallback.
    expect(screen.getByText("acme/web, acme/api")).toBeInTheDocument();
  });

  it("shows the allRepos fallback when repoAllowlist is null", () => {
    getConnectionQuery.mockReturnValue({
      data: { ...connectedFixture, repoAllowlist: null },
      isLoading: false,
      error: null,
    });
    render(<GithubConnectionSettings orgId="org-1" />);
    expect(screen.getByText("All repos visible to the token")).toBeInTheDocument();
  });

  it("renders the non-ok status pills correctly", () => {
    getConnectionQuery.mockReturnValue({
      data: { ...connectedFixture, status: "auth_error" },
      isLoading: false,
      error: null,
    });
    render(<GithubConnectionSettings orgId="org-1" />);
    expect(
      screen.getByText("Auth error — token revoked or missing permissions"),
    ).toBeInTheDocument();
  });

  it("calls syncNow.mutate and shows the queued toast on success", () => {
    getConnectionQuery.mockReturnValue({
      data: connectedFixture,
      isLoading: false,
      error: null,
    });
    render(<GithubConnectionSettings orgId="org-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(syncNowMutate).toHaveBeenCalledWith({ orgId: "org-1" });

    syncNowOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("Sync queued.");
    expect(invalidateConnection).toHaveBeenCalled();
  });

  it("deletes the connection only after window.confirm is accepted", () => {
    getConnectionQuery.mockReturnValue({
      data: connectedFixture,
      isLoading: false,
      error: null,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<GithubConnectionSettings orgId="org-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(confirmSpy).toHaveBeenCalledWith(
      "Remove the GitHub connection? Synced activity data stays.",
    );
    expect(deleteConnectionMutate).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(deleteConnectionMutate).toHaveBeenCalledWith({ orgId: "org-1" });

    deleteConnectionOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("GitHub connection removed.");
    expect(invalidateConnection).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("submits the form with the parsed allowlist array and clears the token field on success", async () => {
    const user = userEvent.setup();
    getConnectionQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    const tokenValue = "github_pat_freshtoken1234567890abcdef";
    setConnectionMutateAsync.mockResolvedValue({
      ownerLogin: "acme",
      tokenLast4: "cdef",
      sampleRepo: "acme/web",
    });

    render(<GithubConnectionSettings orgId="org-1" />);

    await user.type(screen.getByLabelText("Owner"), "acme");
    await user.type(screen.getByLabelText("Fine-grained PAT"), tokenValue);
    await user.type(
      screen.getByLabelText("Repo allowlist (optional, one owner/repo per line)"),
      "acme/web\nacme/api\n\n  ",
    );
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(setConnectionMutateAsync).toHaveBeenCalledWith({
        orgId: "org-1",
        ownerLogin: "acme",
        token: tokenValue,
        repoAllowlist: ["acme/web", "acme/api"],
      }),
    );

    setConnectionOptions.onSuccess?.(
      { ownerLogin: "acme", tokenLast4: "cdef", sampleRepo: "acme/web" },
      { ownerLogin: "acme", token: tokenValue, repoAllowlist: "acme/web\nacme/api" },
    );
    expect(toastSuccess).toHaveBeenCalledWith("Connected — probe saw acme/web.");
    expect(invalidateConnection).toHaveBeenCalled();

    await waitFor(() =>
      expect((screen.getByLabelText("Fine-grained PAT") as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("submits with repoAllowlist undefined when the field is left blank", async () => {
    const user = userEvent.setup();
    getConnectionQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    setConnectionMutateAsync.mockResolvedValue({
      ownerLogin: "acme",
      tokenLast4: "cdef",
      sampleRepo: null,
    });

    render(<GithubConnectionSettings orgId="org-1" />);

    await user.type(screen.getByLabelText("Owner"), "acme");
    await user.type(
      screen.getByLabelText("Fine-grained PAT"),
      "github_pat_freshtoken1234567890abcdef",
    );
    await user.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(setConnectionMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ repoAllowlist: undefined }),
      ),
    );
  });

  // The onError callback is invoked directly (rather than making
  // setConnectionMutateAsync actually reject) — mirroring the established
  // pattern in RubricEditor.keyScope.test.tsx. In the real app react-query
  // invokes this option when the mutation's promise rejects; asserting it
  // directly avoids an unhandled-rejection warning from the unawaited
  // `mutateAsync` call inside the component's form `onSubmit`.
  it("shows the probeFailed toast on a BAD_REQUEST setConnection error", () => {
    getConnectionQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<GithubConnectionSettings orgId="org-1" />);

    setConnectionOptions.onError?.({
      message: "github connection probe failed: bad_credentials",
      data: { code: "BAD_REQUEST" },
    });
    expect(toastError).toHaveBeenCalledWith(
      "GitHub rejected the connection: github connection probe failed: bad_credentials",
    );
  });

  it("shows the insufficient-permission toast on a FORBIDDEN setConnection error", () => {
    getConnectionQuery.mockReturnValue({ data: null, isLoading: false, error: null });
    render(<GithubConnectionSettings orgId="org-1" />);

    setConnectionOptions.onError?.({ message: "forbidden", data: { code: "FORBIDDEN" } });
    expect(toastError).toHaveBeenCalledWith("Insufficient permission");
  });
});
