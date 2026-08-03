import { describe, it, expect } from "vitest";
import { describeFailureReason } from "@/components/requests/replayFailureReason";

describe("describeFailureReason", () => {
  it("returns nothing for a run that did not fail", () => {
    expect(describeFailureReason(null)).toBeNull();
  });

  it("maps each closed-enum reason to its own key", () => {
    for (const reason of [
      "truncated_not_replayable",
      "body_missing",
      "retention_expired",
      "decrypt_failed",
      "eval_key_unavailable",
      "missing_request_id",
      "stale_running",
      "unknown_status",
    ]) {
      expect(describeFailureReason(reason)).toEqual({ key: reason });
    }
  });

  // The status-suffixed form is part of the contract, not a coincidence. An
  // equality check against "upstream_error" would miss EVERY real upstream
  // failure — this is the case that catches that regression.
  it("recognises the status-suffixed upstream failure and surfaces the code", () => {
    expect(describeFailureReason("upstream_error:503")).toEqual({
      key: "upstream_error",
      values: { status: "503" },
    });
    expect(describeFailureReason("upstream_error:429")).toEqual({
      key: "upstream_error",
      values: { status: "429" },
    });
  });

  it("still recognises the bare upstream failure", () => {
    expect(describeFailureReason("upstream_error")).toEqual({
      key: "upstream_error_nostatus",
    });
  });

  it("shows an unrecognised reason verbatim rather than swallowing it", () => {
    expect(describeFailureReason("something_new")).toEqual({
      key: "unknown",
      values: { reason: "something_new" },
    });
  });
});
