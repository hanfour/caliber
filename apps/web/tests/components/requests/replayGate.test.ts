import { describe, it, expect } from "vitest";
import { getReplayGate, type ReplayGateInput } from "@/components/requests/replayGate";

function row(overrides: Partial<ReplayGateInput> = {}): ReplayGateInput {
  return { bodyTruncated: false, hasBody: true, ...overrides };
}

describe("getReplayGate", () => {
  it("enables the button when the body is captured, not truncated, and replay is enabled", () => {
    expect(getReplayGate(row(), true)).toEqual({ disabled: false });
  });

  it("disables with reason 'truncated' when bodyTruncated is true — the button must say so BEFORE the click, not after", () => {
    const gate = getReplayGate(row({ bodyTruncated: true }), true);
    expect(gate).toEqual({ disabled: true, reason: "truncated" });
  });

  it("disables with reason 'noBody' when hasBody is false (never captured, or retention lapsed)", () => {
    const gate = getReplayGate(row({ hasBody: false }), true);
    expect(gate).toEqual({ disabled: true, reason: "noBody" });
  });

  it("disables with reason 'replayDisabled' when replayEnabled is false, even for an otherwise-replayable row", () => {
    const gate = getReplayGate(row(), false);
    expect(gate).toEqual({ disabled: true, reason: "replayDisabled" });
  });

  it("replayEnabled:false wins over a row-level defect — the page-wide reason is reported, not the row's own", () => {
    // Regression guard: if a future edit reorders the checks so a truncated
    // row reports 'truncated' even when replay is globally off, this row
    // would (correctly, on this feature) show a working precondition
    // message for a button that could never have worked in the first place.
    const gate = getReplayGate(
      row({ bodyTruncated: true, hasBody: false }),
      false,
    );
    expect(gate).toEqual({ disabled: true, reason: "replayDisabled" });
  });

  it("bodyTruncated is checked before hasBody when both are true and replay is enabled", () => {
    const gate = getReplayGate(row({ bodyTruncated: true, hasBody: false }), true);
    expect(gate).toEqual({ disabled: true, reason: "truncated" });
  });
});
