import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractOne, type FacetCallDeps, type FacetRow, type FacetSession } from "../../src/facet/extractor";
import { CURRENT_PROMPT_VERSION } from "../../src/facet/promptBuilder";
import {
  BudgetExceededDegrade,
  BudgetExceededHalt,
} from "../../src/budget/errors";

const VALID_FACET_TEXT = JSON.stringify({
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 0,
  bugsCaughtCount: 1,
  codexErrorsCount: 0,
  userSatisfaction: 5,
});

function makeSession(): FacetSession {
  return {
    requestId: "req-1",
    orgId: "org-1",
    turns: [
      { role: "user", content: "implement a thing" },
      { role: "assistant", content: "done" },
    ],
  };
}

function makeDeps(overrides: Partial<FacetCallDeps> = {}): {
  deps: FacetCallDeps;
  insertFacet: ReturnType<typeof vi.fn>;
  callWithCostTracking: ReturnType<typeof vi.fn>;
} {
  const insertFacet = vi.fn().mockResolvedValue(undefined);
  const callWithCostTracking = vi.fn().mockResolvedValue({
    response: {
      text: VALID_FACET_TEXT,
      usage: { input_tokens: 100, output_tokens: 30 },
    },
    cost: 0.0001,
  });
  const deps: FacetCallDeps = {
    callWithCostTracking: callWithCostTracking as unknown as FacetCallDeps["callWithCostTracking"],
    insertFacet: insertFacet as unknown as FacetCallDeps["insertFacet"],
    facetModel: "claude-haiku-4-5",
    ...overrides,
  };
  return { deps, insertFacet, callWithCostTracking };
}

describe("extractOne — happy path", () => {
  it("writes a success row with correct fields and returns FacetFields", async () => {
    const { deps, insertFacet, callWithCostTracking } = makeDeps();
    const session = makeSession();

    const out = await extractOne(session, deps);

    expect(out).toEqual({
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 4,
      frictionCount: 0,
      bugsCaughtCount: 1,
      codexErrorsCount: 0,
      userSatisfaction: 5,
    });

    expect(callWithCostTracking).toHaveBeenCalledTimes(1);
    const callArgs = callWithCostTracking.mock.calls[0]![0];
    expect(callArgs.orgId).toBe("org-1");
    expect(callArgs.eventType).toBe("facet_extraction");
    expect(callArgs.refType).toBe("request_body_facet");
    expect(callArgs.refId).toBe("req-1");
    expect(callArgs.model).toBe("claude-haiku-4-5");

    expect(insertFacet).toHaveBeenCalledTimes(1);
    const row = insertFacet.mock.calls[0]![0] as FacetRow;
    expect(row.requestId).toBe("req-1");
    expect(row.orgId).toBe("org-1");
    expect(row.sessionType).toBe("feature_dev");
    expect(row.outcome).toBe("success");
    expect(row.claudeHelpfulness).toBe(4);
    expect(row.frictionCount).toBe(0);
    expect(row.bugsCaughtCount).toBe(1);
    expect(row.codexErrorsCount).toBe(0);
    expect(row.userSatisfaction).toBe(5);
    expect(row.extractedWithModel).toBe("claude-haiku-4-5");
    expect(row.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(row.extractionError).toBeNull();
  });
});

describe("extractOne — deterministic failures (write row with extractionError)", () => {
  it("writes a parse_error row when LLM returns non-JSON", async () => {
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockResolvedValue({
        response: {
          text: "not json at all {{{",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        cost: 0,
      })) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();

    expect(insertFacet).toHaveBeenCalledTimes(1);
    const row = insertFacet.mock.calls[0]![0] as FacetRow;
    expect(row.extractionError).toMatch(/^parse_error:/);
    expect(row.sessionType).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.claudeHelpfulness).toBeNull();
    expect(row.userSatisfaction).toBeNull();
    expect(row.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(row.extractedWithModel).toBe("claude-haiku-4-5");
  });

  it("writes a validation_error row when LLM returns out-of-range claudeHelpfulness", async () => {
    const bad = JSON.stringify({
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 9,
      frictionCount: 0,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
    });
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockResolvedValue({
        response: { text: bad, usage: { input_tokens: 10, output_tokens: 5 } },
        cost: 0,
      })) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();

    expect(insertFacet).toHaveBeenCalledTimes(1);
    const row = insertFacet.mock.calls[0]![0] as FacetRow;
    expect(row.extractionError).toMatch(/^validation_error:/);
    expect(row.userSatisfaction).toBeNull();
  });

  it("writes a timeout row when LLM call rejects with timeout error (no status)", async () => {
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockRejectedValue(
        new Error("timeout after 15s"),
      )) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();

    expect(insertFacet).toHaveBeenCalledTimes(1);
    const row = insertFacet.mock.calls[0]![0] as FacetRow;
    expect(row.extractionError).toMatch(/^timeout:/);
    expect(row.userSatisfaction).toBeNull();
    expect(row.promptVersion).toBe(CURRENT_PROMPT_VERSION);
  });
});

describe("extractOne — transient failures (skip row, retry next pass)", () => {
  it("returns null and does NOT write a row on BudgetExceededDegrade", async () => {
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockRejectedValue(
        new BudgetExceededDegrade({
          orgId: "org-1",
          estimatedCost: 0.01,
          currentSpend: 1,
          budget: 1,
        }),
      )) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();
    expect(insertFacet).not.toHaveBeenCalled();
  });

  it("returns null and does NOT write a row on BudgetExceededHalt", async () => {
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockRejectedValue(
        new BudgetExceededHalt({
          orgId: "org-1",
          estimatedCost: 0.01,
          currentSpend: 5,
          budget: 1,
        }),
      )) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();
    expect(insertFacet).not.toHaveBeenCalled();
  });

  it("returns null and does NOT write a row on 5xx api error", async () => {
    const apiError = Object.assign(new Error("Anthropic 503 Service Unavailable"), {
      status: 503,
    });
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockRejectedValue(
        apiError,
      )) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();
    expect(insertFacet).not.toHaveBeenCalled();
  });

  it("returns null and does NOT write a row on 429 rate limit (upstream will recover)", async () => {
    const apiError = Object.assign(new Error("Facet LLM call non-2xx: 429"), {
      status: 429,
    });
    const { deps, insertFacet } = makeDeps({
      callWithCostTracking: (vi.fn().mockRejectedValue(
        apiError,
      )) as unknown as FacetCallDeps["callWithCostTracking"],
    });

    const out = await extractOne(makeSession(), deps);
    expect(out).toBeNull();
    expect(insertFacet).not.toHaveBeenCalled();
  });
});

describe("extractOne — misc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the configured facetModel for both the LLM call and the row", async () => {
    const { deps, insertFacet, callWithCostTracking } = makeDeps({
      facetModel: "claude-sonnet-4-6",
    });

    await extractOne(makeSession(), deps);

    expect(callWithCostTracking.mock.calls[0]![0].model).toBe(
      "claude-sonnet-4-6",
    );
    const row = insertFacet.mock.calls[0]![0] as FacetRow;
    expect(row.extractedWithModel).toBe("claude-sonnet-4-6");
  });

  it("estimates input tokens from prompt length (system + user / 4)", async () => {
    const { deps, callWithCostTracking } = makeDeps();
    await extractOne(makeSession(), deps);

    const args = callWithCostTracking.mock.calls[0]![0];
    expect(args.estimatedInputTokens).toBeGreaterThan(0);
    // Sanity bound: prompt is small but non-trivial
    expect(args.estimatedInputTokens).toBeLessThan(10_000);
  });
});
