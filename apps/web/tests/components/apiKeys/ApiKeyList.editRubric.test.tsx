import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}));

vi.mock("@/components/apiKeys/ApiKeyCreateDialog", () => ({
  ApiKeyCreateDialog: () => null,
}));

// Mock RubricEditor so we don't have to satisfy its trpc dependencies
vi.mock("@/components/evaluator/RubricEditor", () => ({
  RubricEditor: ({ onCancel }: { onCancel: () => void }) => (
    <div data-testid="rubric-editor">
      <button onClick={onCancel}>close</button>
    </div>
  ),
}));

const listOwnQuery = vi.fn();
const listOwnInvalidate = vi.fn();
const setEvalMutate = vi.fn();
const deleteForKeyMutate = vi.fn();
let deleteForKeyOptions: { onSuccess?: () => void; onError?: (e: unknown) => void } = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({
      apiKeys: { listOwn: { invalidate: listOwnInvalidate } },
    }),
    apiKeys: {
      listOwn: { useQuery: (...a: unknown[]) => listOwnQuery(...a) },
      setEvaluateAsProject: {
        useMutation: () => ({ mutate: setEvalMutate, isPending: false }),
      },
      revoke: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    rubrics: {
      deleteForKey: {
        useMutation: (opts: typeof deleteForKeyOptions) => {
          deleteForKeyOptions = opts ?? {};
          return { mutate: deleteForKeyMutate, isPending: false };
        },
      },
    },
  },
}));

// Mock usePermissions
const canFn = vi.fn();
const permMock = { userId: "user-1" };
const sessionMock = { coveredOrgs: ["org-1"] };

vi.mock("@/lib/usePermissions", () => ({
  usePermissions: () => ({
    can: canFn,
    perm: permMock,
    session: sessionMock,
    isLoading: false,
  }),
}));

import { ApiKeyList } from "@/components/apiKeys/ApiKeyList";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function setupList(rows: ReturnType<typeof makeRow>[]) {
  listOwnQuery.mockReturnValue({ data: rows, isLoading: false, error: null });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ApiKeyList — Edit rubric button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteForKeyOptions = {};
    // Default: can() returns true
    canFn.mockReturnValue(true);
  });

  it("does NOT render Edit rubric button when evaluateAsProject is false", () => {
    setupList([makeRow({ evaluateAsProject: false })]);
    render(<ApiKeyList />);
    expect(screen.queryByText("Edit project rubric")).not.toBeInTheDocument();
  });

  it("renders Edit rubric button when evaluateAsProject is true and can() is true", () => {
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);
    expect(screen.getByText("Edit project rubric")).toBeInTheDocument();
  });

  it("does NOT render Edit rubric button when can() returns false", () => {
    canFn.mockReturnValue(false);
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);
    expect(screen.queryByText("Edit project rubric")).not.toBeInTheDocument();
  });

  it("clicking Edit rubric opens the rubric editor dialog", () => {
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);

    fireEvent.click(screen.getByText("Edit project rubric"));
    expect(screen.getByTestId("rubric-editor")).toBeInTheDocument();
  });

  it("clicking close in the rubric editor dismisses it", () => {
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);

    fireEvent.click(screen.getByText("Edit project rubric"));
    expect(screen.getByTestId("rubric-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("rubric-editor")).not.toBeInTheDocument();
  });

  it("renders Remove project rubric button when evaluateAsProject is true and can() is true", () => {
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);
    expect(screen.getByText("Remove project rubric")).toBeInTheDocument();
  });

  it("does NOT render Remove project rubric button when evaluateAsProject is false", () => {
    setupList([makeRow({ evaluateAsProject: false })]);
    render(<ApiKeyList />);
    expect(screen.queryByText("Remove project rubric")).not.toBeInTheDocument();
  });

  it("shows removedToast on deleteForKey success", () => {
    setupList([makeRow({ evaluateAsProject: true })]);
    render(<ApiKeyList />);
    deleteForKeyOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("Project rubric removed");
  });
});
