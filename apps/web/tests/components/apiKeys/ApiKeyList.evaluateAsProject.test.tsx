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

// The revoke flow uses the confirm dialog; not exercised here, stub it.
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}));

// The create dialog mounts unconditionally (open=false); stub it so we don't
// have to satisfy its own trpc dependencies.
vi.mock("@/components/apiKeys/ApiKeyCreateDialog", () => ({
  ApiKeyCreateDialog: () => null,
}));

const listOwnQuery = vi.fn();
const listOwnInvalidate = vi.fn();
const setEvalMutate = vi.fn();
// Capture the options object passed to setEvaluateAsProject.useMutation so the
// test can drive its onSuccess / onError callbacks directly.
let setEvalOptions: {
  onSuccess?: (data: unknown, vars: { id: string; enabled: boolean }) => void;
  onError?: (err: { data?: { code?: string }; message?: string }) => void;
} = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({ apiKeys: { listOwn: { invalidate: listOwnInvalidate } } }),
    apiKeys: {
      listOwn: { useQuery: (...a: unknown[]) => listOwnQuery(...a) },
      setEvaluateAsProject: {
        useMutation: (opts: typeof setEvalOptions) => {
          setEvalOptions = opts ?? {};
          return { mutate: setEvalMutate, isPending: false };
        },
      },
      revoke: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

import { ApiKeyList } from "@/components/apiKeys/ApiKeyList";

function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "key-1",
    name: "mykey",
    prefix: "ak_abc",
    status: "active",
    createdAt: "2026-06-01T00:00:00Z",
    lastUsedAt: null,
    evaluateAsProject: false,
    ...over,
  };
}

describe("ApiKeyList — Score as project toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEvalOptions = {};
  });

  it("renders the toggle checked when evaluateAsProject is true", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow({ evaluateAsProject: true })],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    const toggle = screen.getByRole("checkbox", {
      name: 'Toggle project scoring for "mykey"',
    });
    expect(toggle).toBeChecked();
  });

  it("renders the toggle unchecked when evaluateAsProject is false", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow({ evaluateAsProject: false })],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    const toggle = screen.getByRole("checkbox", {
      name: 'Toggle project scoring for "mykey"',
    });
    expect(toggle).not.toBeChecked();
  });

  it("clicking an unchecked toggle calls the mutation with enabled: true", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow({ id: "key-9", evaluateAsProject: false })],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: 'Toggle project scoring for "mykey"',
      }),
    );
    expect(setEvalMutate).toHaveBeenCalledWith({ id: "key-9", enabled: true });
  });

  it("clicking a checked toggle calls the mutation with enabled: false", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow({ id: "key-9", evaluateAsProject: true })],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: 'Toggle project scoring for "mykey"',
      }),
    );
    expect(setEvalMutate).toHaveBeenCalledWith({ id: "key-9", enabled: false });
  });

  it("shows the enabled toast on success when enabling", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    setEvalOptions.onSuccess?.(undefined, { id: "key-1", enabled: true });
    expect(toastSuccess).toHaveBeenCalledWith("Project scoring enabled");
    expect(listOwnInvalidate).toHaveBeenCalled();
  });

  it("shows the disabled toast on success when disabling", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    setEvalOptions.onSuccess?.(undefined, { id: "key-1", enabled: false });
    expect(toastSuccess).toHaveBeenCalledWith("Project scoring disabled");
  });

  it("shows the error toast on a generic mutation error", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    setEvalOptions.onError?.({ data: { code: "INTERNAL_SERVER_ERROR" }, message: "boom" });
    expect(toastError).toHaveBeenCalledWith("Failed to update project scoring");
  });

  it("shows the permission message on a FORBIDDEN error", () => {
    listOwnQuery.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      error: null,
    });
    render(<ApiKeyList />);

    setEvalOptions.onError?.({ data: { code: "FORBIDDEN" }, message: "nope" });
    // common.insufficientPermission, resolved from en.json by the next-intl mock.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalledWith("Failed to update project scoring");
  });
});
