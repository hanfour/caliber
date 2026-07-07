import { describe, it, expect } from "vitest";
import { evalAccountPin } from "../../src/runtime/evalAccountPin.js";

const acct = "11111111-1111-1111-1111-111111111111";

describe("evalAccountPin", () => {
  it("returns the pin when the caller holds an eval key", () => {
    expect(
      evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: { "x-caliber-eval-account-id": acct } }),
    ).toBe(acct);
  });

  it("ignores the header for a normal (non-eval) key — anti-forgery", () => {
    expect(
      evalAccountPin({ apiKey: { keyPrefix: "ak_1234" }, headers: { "x-caliber-eval-account-id": acct } }),
    ).toBeUndefined();
  });

  it("returns undefined when the header is absent", () => {
    expect(evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: {} })).toBeUndefined();
  });

  it("handles array-valued headers (takes the first)", () => {
    expect(
      evalAccountPin({ apiKey: { keyPrefix: "caliber-eval" }, headers: { "x-caliber-eval-account-id": [acct, "x"] } }),
    ).toBe(acct);
  });
});
