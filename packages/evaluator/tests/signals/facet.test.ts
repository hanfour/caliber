import { describe, it, expect } from "vitest";
import {
  collectFacetClaudeHelpfulness,
  collectFacetFrictionPerSession,
  collectFacetBugsCaught,
  collectFacetCodexErrors,
  collectFacetOutcomeSuccessRate,
  collectFacetSessionTypeRatio,
  collectFacetUserSatisfaction,
  type FacetRowInput,
} from "../../src/signals/facet";

function makeRow(overrides: Partial<FacetRowInput> = {}): FacetRowInput {
  return {
    sessionType: null,
    outcome: null,
    claudeHelpfulness: null,
    frictionCount: null,
    bugsCaughtCount: null,
    codexErrorsCount: null,
    userSatisfaction: null,
    ...overrides,
  };
}

describe("collectFacetClaudeHelpfulness", () => {
  it("returns hit:false, value:0 on empty rows", () => {
    const r = collectFacetClaudeHelpfulness({ rows: [], gte: 4 });
    expect(r).toEqual({ hit: false, value: 0, evidence: [], sampleCount: 0 });
  });

  it("returns hit:false, value:0 when all rows have null helpfulness", () => {
    const rows = [makeRow(), makeRow({ outcome: "success" })];
    const r = collectFacetClaudeHelpfulness({ rows, gte: 3 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("ignores null entries when computing the mean", () => {
    const rows = [
      makeRow({ claudeHelpfulness: 5 }),
      makeRow({ claudeHelpfulness: 3 }),
      makeRow(),
    ];
    const r = collectFacetClaudeHelpfulness({ rows, gte: 4 });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when mean falls below gte", () => {
    const rows = [
      makeRow({ claudeHelpfulness: 2 }),
      makeRow({ claudeHelpfulness: 3 }),
    ];
    const r = collectFacetClaudeHelpfulness({ rows, gte: 4 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(2.5);
  });
});

describe("collectFacetFrictionPerSession", () => {
  it("treats absent data as hit:true (refusalRate-style inverted convention)", () => {
    const r = collectFacetFrictionPerSession({ rows: [], lte: 1 });
    expect(r).toEqual({ hit: true, value: 0, evidence: [], sampleCount: 0 });
  });

  it("returns hit:true when mean friction <= lte", () => {
    const rows = [
      makeRow({ frictionCount: 0 }),
      makeRow({ frictionCount: 1 }),
    ];
    const r = collectFacetFrictionPerSession({ rows, lte: 1 });
    expect(r.value).toBe(0.5);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when mean friction exceeds lte", () => {
    const rows = [
      makeRow({ frictionCount: 3 }),
      makeRow({ frictionCount: 5 }),
    ];
    const r = collectFacetFrictionPerSession({ rows, lte: 1 });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(false);
  });
});

describe("collectFacetBugsCaught", () => {
  it("returns hit:false, value:0 on empty rows", () => {
    const r = collectFacetBugsCaught({ rows: [], gte: 1 });
    expect(r).toEqual({ hit: false, value: 0, evidence: [], sampleCount: 0 });
  });

  it("sums non-null bug counts and hits when sum >= gte", () => {
    const rows = [
      makeRow({ bugsCaughtCount: 2 }),
      makeRow({ bugsCaughtCount: 1 }),
      makeRow(),
    ];
    const r = collectFacetBugsCaught({ rows, gte: 3 });
    expect(r.value).toBe(3);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when sum is below gte", () => {
    const rows = [makeRow({ bugsCaughtCount: 1 })];
    const r = collectFacetBugsCaught({ rows, gte: 5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(1);
  });
});

describe("collectFacetCodexErrors", () => {
  it("treats absent data as hit:true (inverted convention)", () => {
    const r = collectFacetCodexErrors({ rows: [], lte: 0 });
    expect(r).toEqual({ hit: true, value: 0, evidence: [], sampleCount: 0 });
  });

  it("returns hit:true when sum <= lte", () => {
    const rows = [
      makeRow({ codexErrorsCount: 0 }),
      makeRow({ codexErrorsCount: 1 }),
    ];
    const r = collectFacetCodexErrors({ rows, lte: 2 });
    expect(r.value).toBe(1);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when sum exceeds lte", () => {
    const rows = [
      makeRow({ codexErrorsCount: 3 }),
      makeRow({ codexErrorsCount: 4 }),
    ];
    const r = collectFacetCodexErrors({ rows, lte: 2 });
    expect(r.value).toBe(7);
    expect(r.hit).toBe(false);
  });
});

describe("collectFacetOutcomeSuccessRate", () => {
  it("returns hit:false, value:0 when no rows have an outcome", () => {
    const rows = [makeRow(), makeRow({ frictionCount: 0 })];
    const r = collectFacetOutcomeSuccessRate({ rows, gte: 0.5 });
    expect(r).toEqual({ hit: false, value: 0, evidence: [], sampleCount: 0 });
  });

  it("counts both 'success' and 'partial' as wins", () => {
    const rows = [
      makeRow({ outcome: "success" }),
      makeRow({ outcome: "partial" }),
      makeRow({ outcome: "failure" }),
      makeRow({ outcome: "abandoned" }),
    ];
    const r = collectFacetOutcomeSuccessRate({ rows, gte: 0.5 });
    expect(r.value).toBe(0.5);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when ratio falls below gte", () => {
    const rows = [
      makeRow({ outcome: "success" }),
      makeRow({ outcome: "failure" }),
      makeRow({ outcome: "failure" }),
      makeRow({ outcome: "failure" }),
    ];
    const r = collectFacetOutcomeSuccessRate({ rows, gte: 0.5 });
    expect(r.value).toBe(0.25);
    expect(r.hit).toBe(false);
  });
});

describe("collectFacetSessionTypeRatio", () => {
  it("returns hit:false, value:0 when no rows have a sessionType", () => {
    const rows = [makeRow(), makeRow({ outcome: "success" })];
    const r = collectFacetSessionTypeRatio({
      rows,
      targetType: "feature_dev",
      gte: 0.3,
    });
    expect(r).toEqual({ hit: false, value: 0, evidence: [], sampleCount: 0 });
  });

  it("returns ratio:0 when no rows match the targetType", () => {
    const rows = [
      makeRow({ sessionType: "bug_fix" }),
      makeRow({ sessionType: "exploration" }),
    ];
    const r = collectFacetSessionTypeRatio({
      rows,
      targetType: "feature_dev",
      gte: 0.3,
    });
    expect(r.value).toBe(0);
    expect(r.hit).toBe(false);
  });

  it("computes ratio over rows with non-null sessionType only", () => {
    const rows = [
      makeRow({ sessionType: "feature_dev" }),
      makeRow({ sessionType: "feature_dev" }),
      makeRow({ sessionType: "bug_fix" }),
      makeRow(),
    ];
    const r = collectFacetSessionTypeRatio({
      rows,
      targetType: "feature_dev",
      gte: 0.5,
    });
    expect(r.value).toBeCloseTo(2 / 3, 5);
    expect(r.hit).toBe(true);
  });

  it("returns hit:false when ratio is below gte", () => {
    const rows = [
      makeRow({ sessionType: "feature_dev" }),
      makeRow({ sessionType: "bug_fix" }),
      makeRow({ sessionType: "bug_fix" }),
      makeRow({ sessionType: "bug_fix" }),
    ];
    const r = collectFacetSessionTypeRatio({
      rows,
      targetType: "feature_dev",
      gte: 0.5,
    });
    expect(r.value).toBe(0.25);
    expect(r.hit).toBe(false);
  });
});

describe("sampleCount (v2)", () => {
  it("reports the number of non-null rows", () => {
    const r = collectFacetClaudeHelpfulness({
      rows: [makeRow({ claudeHelpfulness: 4 }), makeRow({}), makeRow({ claudeHelpfulness: 2 })],
      gte: 3,
    });
    expect(r.sampleCount).toBe(2);
  });

  it("is 0 for empty input — including inverted collectors", () => {
    expect(collectFacetFrictionPerSession({ rows: [], lte: 1 }).sampleCount).toBe(0);
    expect(collectFacetCodexErrors({ rows: [], lte: 1 }).sampleCount).toBe(0);
  });
});

describe("normalize per_session (v2)", () => {
  it("bugs_caught: value becomes sum / rows-with-data", () => {
    const r = collectFacetBugsCaught({
      rows: [makeRow({ bugsCaughtCount: 3 }), makeRow({ bugsCaughtCount: 1 }), makeRow({})],
      gte: 1,
      normalize: "per_session",
    });
    expect(r.value).toBe(2); // (3+1)/2
    expect(r.sampleCount).toBe(2);
  });

  it("codex_errors: normalized value keeps lte hit semantics", () => {
    const r = collectFacetCodexErrors({
      rows: [makeRow({ codexErrorsCount: 2 }), makeRow({ codexErrorsCount: 0 })],
      lte: 1.5,
      normalize: "per_session",
    });
    expect(r.value).toBe(1); // (2+0)/2
    expect(r.hit).toBe(true);
  });

  it("without normalize the legacy sum behaviour is unchanged", () => {
    const r = collectFacetBugsCaught({
      rows: [makeRow({ bugsCaughtCount: 3 }), makeRow({ bugsCaughtCount: 1 })],
      gte: 4,
    });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(true);
  });
});

describe("collectFacetUserSatisfaction (v2)", () => {
  it("means non-null values and hits on gte", () => {
    const r = collectFacetUserSatisfaction({
      rows: [makeRow({ userSatisfaction: 5 }), makeRow({ userSatisfaction: 3 }), makeRow({})],
      gte: 4,
    });
    expect(r.value).toBe(4);
    expect(r.hit).toBe(true);
    expect(r.sampleCount).toBe(2);
  });

  it("empty input → hit:false, sampleCount 0", () => {
    const r = collectFacetUserSatisfaction({ rows: [], gte: 3 });
    expect(r.hit).toBe(false);
    expect(r.sampleCount).toBe(0);
  });
});
