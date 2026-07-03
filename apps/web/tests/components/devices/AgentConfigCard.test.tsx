import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

let permMock: {
  can: () => boolean;
  session: { coveredOrgs: string[] } | null;
  isLoading: boolean;
} = {
  can: () => true,
  session: { coveredOrgs: ["org-1"] },
  isLoading: false,
};

vi.mock("@/lib/usePermissions", () => ({
  usePermissions: () => permMock,
}));

const getQuery = vi.fn();
const getInvalidate = vi.fn();
const setMutate = vi.fn();
let setOptions: {
  onSuccess?: (
    data: { ok: true; pollIntervalSeconds: number },
    vars: { orgId: string; pollIntervalSeconds: number },
  ) => void;
  onError?: (err: { data?: { code?: string }; message?: string }) => void;
} = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      devices: { agentConfig: { get: { invalidate: getInvalidate } } },
    }),
    devices: {
      agentConfig: {
        get: { useQuery: (...a: unknown[]) => getQuery(...a) },
        set: {
          useMutation: (opts: typeof setOptions) => {
            setOptions = opts ?? {};
            return { mutate: setMutate, isPending: false };
          },
        },
      },
    },
  },
}));

import { AgentConfigCard } from "@/components/devices/AgentConfigCard";

describe("AgentConfigCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOptions = {};
    permMock = {
      can: () => true,
      session: { coveredOrgs: ["org-1"] },
      isLoading: false,
    };
    getQuery.mockReturnValue({
      data: { pollIntervalSeconds: 60 },
      isLoading: false,
      error: null,
    });
  });

  it("shows the current poll interval seeded from the query", () => {
    render(<AgentConfigCard />);
    const input = screen.getByLabelText("Upload interval (seconds)") as HTMLInputElement;
    expect(input.value).toBe("60");
  });

  it("saving a new value calls the set mutation with the org id and value", () => {
    render(<AgentConfigCard />);
    const input = screen.getByLabelText("Upload interval (seconds)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setMutate).toHaveBeenCalledWith({ orgId: "org-1", pollIntervalSeconds: 5 });
  });

  it("shows a saved toast on success", () => {
    render(<AgentConfigCard />);
    setOptions.onSuccess?.(
      { ok: true, pollIntervalSeconds: 5 },
      { orgId: "org-1", pollIntervalSeconds: 5 },
    );
    expect(toastSuccess).toHaveBeenCalledWith("Saved");
  });

  it("renders nothing for a non-admin", () => {
    permMock = {
      can: () => false,
      session: { coveredOrgs: ["org-1"] },
      isLoading: false,
    };
    const { container } = render(<AgentConfigCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the user has no org", () => {
    permMock = { can: () => true, session: { coveredOrgs: [] }, isLoading: false };
    const { container } = render(<AgentConfigCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
