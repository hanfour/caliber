import { describe, it, expect } from "vitest";
import { classifyUpstreamError } from "../../src/stateMachine/classifier.js";

describe("classifier 401/403 (auth_invalid, no state mutation)", () => {
  it("401 → switch_account, auth_invalid, and NO stateUpdate", () => {
    const a = classifyUpstreamError({ status: 401, message: "invalid x-api-key" });
    expect(a.kind).toBe("switch_account");
    if (a.kind === "switch_account") {
      expect(a.reason).toBe("auth_invalid");
      expect(a.stateUpdate).toBeUndefined();
    }
  });
  it("403 → switch_account, auth_invalid, and NO stateUpdate", () => {
    const a = classifyUpstreamError({ status: 403, message: "forbidden" });
    expect(a.kind).toBe("switch_account");
    if (a.kind === "switch_account") {
      expect(a.reason).toBe("auth_invalid");
      expect(a.stateUpdate).toBeUndefined();
    }
  });
});
