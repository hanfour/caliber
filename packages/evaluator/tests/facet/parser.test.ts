import { describe, it, expect } from "vitest";
import {
  parseFacet,
  FacetParseError,
  FacetValidationError,
} from "../../src/facet/parser";

const VALID = {
  sessionType: "feature_dev",
  outcome: "success",
  claudeHelpfulness: 4,
  frictionCount: 0,
  bugsCaughtCount: 1,
  codexErrorsCount: 0,
  userSatisfaction: 4,
};

describe("parseFacet", () => {
  it("parses valid plain JSON", () => {
    const out = parseFacet(JSON.stringify(VALID));
    expect(out).toEqual(VALID);
  });

  it("parses code-fenced JSON with ```json prefix", () => {
    const fenced = "```json\n" + JSON.stringify(VALID) + "\n```";
    const out = parseFacet(fenced);
    expect(out).toEqual(VALID);
  });

  it("throws FacetParseError on invalid JSON", () => {
    expect(() => parseFacet("not json {{{")).toThrow(FacetParseError);
  });

  it("throws FacetValidationError when claudeHelpfulness=0", () => {
    const bad = JSON.stringify({ ...VALID, claudeHelpfulness: 0 });
    expect(() => parseFacet(bad)).toThrow(FacetValidationError);
  });

  it("throws FacetValidationError when claudeHelpfulness=6", () => {
    const bad = JSON.stringify({ ...VALID, claudeHelpfulness: 6 });
    expect(() => parseFacet(bad)).toThrow(FacetValidationError);
  });

  it("throws FacetValidationError on invalid sessionType enum value", () => {
    const bad = JSON.stringify({ ...VALID, sessionType: "coding" });
    expect(() => parseFacet(bad)).toThrow(FacetValidationError);
  });

  it("throws FacetValidationError on missing required field (outcome)", () => {
    const { outcome: _outcome, ...rest } = VALID;
    expect(() => parseFacet(JSON.stringify(rest))).toThrow(
      FacetValidationError,
    );
  });

  it("throws FacetValidationError on negative count", () => {
    const bad = JSON.stringify({ ...VALID, frictionCount: -1 });
    expect(() => parseFacet(bad)).toThrow(FacetValidationError);
  });

  it("silently drops extra fields", () => {
    const withExtra = JSON.stringify({
      ...VALID,
      extraField: "ignored",
      anotherOne: 42,
    });
    const out = parseFacet(withExtra);
    expect(out).toEqual(VALID);
    expect(out).not.toHaveProperty("extraField");
  });

  it("parses JSON with leading prose", () => {
    const noisy = "Here is the result:\n" + JSON.stringify(VALID);
    const out = parseFacet(noisy);
    expect(out).toEqual(VALID);
  });

  it("parses userSatisfaction and rejects out-of-range values (v2)", () => {
    const ok = parseFacet(JSON.stringify({
      sessionType: "bug_fix",
      outcome: "success",
      claudeHelpfulness: 4,
      frictionCount: 0,
      bugsCaughtCount: 1,
      codexErrorsCount: 0,
      userSatisfaction: 5,
    }));
    expect(ok.userSatisfaction).toBe(5);

    expect(() => parseFacet(JSON.stringify({
      sessionType: "bug_fix",
      outcome: "success",
      claudeHelpfulness: 4,
      frictionCount: 0,
      bugsCaughtCount: 1,
      codexErrorsCount: 0,
      userSatisfaction: 0,
    }))).toThrow(FacetValidationError);

    // Missing userSatisfaction → validation error (v2 required field)
    expect(() => parseFacet(JSON.stringify({
      sessionType: "bug_fix",
      outcome: "success",
      claudeHelpfulness: 4,
      frictionCount: 0,
      bugsCaughtCount: 1,
      codexErrorsCount: 0,
    }))).toThrow(FacetValidationError);
  });
});
