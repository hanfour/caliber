import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mocks (hoisted above the component import) ───────────────────────────────

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

// Stub validation resolver so the form submits without actual Zod parsing
vi.mock("@/lib/i18n/useTranslatedZodResolver", () => ({
  useTranslatedZodResolver: () => async (values: unknown) => ({
    values,
    errors: {},
  }),
}));

// Stub @caliber/evaluator imports used inside RubricEditor
vi.mock("@caliber/evaluator", () => ({
  rubricSchema: {
    safeParse: () => ({ success: true }),
  },
}));

vi.mock("@caliber/i18n-validation", () => ({
  formatValidationKey: (k: string) => k,
}));

const getQuery = vi.fn();
const createMutate = vi.fn();
const updateMutate = vi.fn();
const getForKeyQuery = vi.fn();
const upsertForKeyMutate = vi.fn();
let createOptions: { onSuccess?: () => void; onError?: (e: unknown) => void } = {};
let updateOptions: { onSuccess?: () => void; onError?: (e: unknown) => void } = {};
let upsertForKeyOptions: { onSuccess?: () => void; onError?: (e: unknown) => void } = {};

vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    useUtils: () => ({}),
    rubrics: {
      get: {
        useQuery: (...a: unknown[]) => getQuery(...a),
      },
      create: {
        useMutation: (opts: typeof createOptions) => {
          createOptions = opts ?? {};
          return { mutateAsync: createMutate, isPending: false };
        },
      },
      update: {
        useMutation: (opts: typeof updateOptions) => {
          updateOptions = opts ?? {};
          return { mutateAsync: updateMutate, isPending: false };
        },
      },
      getForKey: {
        useQuery: (...a: unknown[]) => getForKeyQuery(...a),
      },
      upsertForKey: {
        useMutation: (opts: typeof upsertForKeyOptions) => {
          upsertForKeyOptions = opts ?? {};
          return { mutateAsync: upsertForKeyMutate, isPending: false };
        },
      },
    },
    me: {
      session: { useQuery: () => ({ data: null, isLoading: false }) },
    },
  },
}));

import { RubricEditor } from "@/components/evaluator/RubricEditor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderKeyScope() {
  getForKeyQuery.mockReturnValue({ data: null, isLoading: false });
  getQuery.mockReturnValue({ data: null, isLoading: false });

  return render(
    <RubricEditor
      target={{ scope: "key", apiKeyId: "key-1", orgId: "org-1" }}
      onSuccess={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

function renderOrgScope(editingRow: { id: string; name: string } | null = null) {
  getQuery.mockReturnValue({ data: null, isLoading: false });
  getForKeyQuery.mockReturnValue({ data: null, isLoading: false });

  return render(
    <RubricEditor
      target={{ scope: "org", orgId: "org-1" }}
      editingRow={editingRow as Parameters<typeof RubricEditor>[0]["editingRow"]}
      onSuccess={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("RubricEditor — key scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOptions = {};
    updateOptions = {};
    upsertForKeyOptions = {};
    upsertForKeyMutate.mockResolvedValue({ id: "new-rubric-id" });
    createMutate.mockResolvedValue({ id: "new-rubric-id" });
    updateMutate.mockResolvedValue({ id: "existing-rubric-id" });
  });

  it("calls rubrics.getForKey.useQuery with the correct apiKeyId and enabled:true", () => {
    renderKeyScope();
    expect(getForKeyQuery).toHaveBeenCalledWith(
      { apiKeyId: "key-1" },
      expect.objectContaining({ enabled: true }),
    );
  });

  it("calls rubrics.get.useQuery with enabled:false in key scope", () => {
    renderKeyScope();
    const [[, opts]] = getQuery.mock.calls;
    expect(opts).toMatchObject({ enabled: false });
  });

  it("calls rubrics.upsertForKey.mutateAsync on submit in key scope", async () => {
    renderKeyScope();

    fireEvent.change(screen.getByPlaceholderText(/Engineering Excellence/i), {
      target: { value: "My Key Rubric" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 1.0.0"), {
      target: { value: "1.0.0" },
    });
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: { value: '{"name":"r","version":"1.0.0","sections":[]}' },
    });

    // No existing rubric → button says "Create rubric"; upsertForKey is still used
    const submitBtn = screen.getByRole("button", { name: /create rubric/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(upsertForKeyMutate).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId: "key-1", name: "My Key Rubric" }),
      );
    });
  });

  it("does NOT call rubrics.create or rubrics.update on submit in key scope", async () => {
    renderKeyScope();

    fireEvent.change(screen.getByPlaceholderText(/Engineering Excellence/i), {
      target: { value: "My Key Rubric" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 1.0.0"), {
      target: { value: "1.0.0" },
    });
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: { value: '{"name":"r","version":"1.0.0","sections":[]}' },
    });

    // No existing rubric → "Create rubric" button; but mutation is upsertForKey not create
    const submitBtn = screen.getByRole("button", { name: /create rubric/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createMutate).not.toHaveBeenCalled();
      expect(updateMutate).not.toHaveBeenCalled();
    });
  });

  it("shows savedToast on upsert success", () => {
    renderKeyScope();
    upsertForKeyOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("Project rubric saved");
  });

  it("shows insufficientPermission on upsert FORBIDDEN", () => {
    renderKeyScope();
    upsertForKeyOptions.onError?.({ data: { code: "FORBIDDEN" }, message: "nope" });
    expect(toastError).toHaveBeenCalledWith("Insufficient permission");
  });

  it("shows generic error message on non-FORBIDDEN error", () => {
    renderKeyScope();
    upsertForKeyOptions.onError?.({ data: { code: "BAD_REQUEST" }, message: "bad json" });
    expect(toastError).toHaveBeenCalledWith("bad json");
  });
});

describe("RubricEditor — org scope (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOptions = {};
    updateOptions = {};
    upsertForKeyOptions = {};
    createMutate.mockResolvedValue({ id: "new-rubric-id" });
    updateMutate.mockResolvedValue({ id: "existing-rubric-id" });
  });

  it("calls rubrics.create on submit when no editingRow", async () => {
    renderOrgScope(null);

    fireEvent.change(screen.getByPlaceholderText(/Engineering Excellence/i), {
      target: { value: "Org Rubric" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 1.0.0"), {
      target: { value: "1.0.0" },
    });
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, {
      target: { value: '{"name":"r","version":"1.0.0","sections":[]}' },
    });

    const submitBtn = screen.getByRole("button", { name: /create rubric/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-1", name: "Org Rubric" }),
      );
      expect(upsertForKeyMutate).not.toHaveBeenCalled();
    });
  });

  it("calls rubrics.getForKey.useQuery with enabled:false in org scope", () => {
    renderOrgScope(null);
    const [[, opts]] = getForKeyQuery.mock.calls;
    expect(opts).toMatchObject({ enabled: false });
  });

  it("shows createdToast on create success in org scope", () => {
    renderOrgScope(null);
    createOptions.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith("Rubric created");
  });
});
