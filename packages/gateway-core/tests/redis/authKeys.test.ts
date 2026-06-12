import { describe, it, expect } from "vitest";
import { authFailKey, authGraceKey } from "../../src/redis/authKeys.js";

describe("auth health redis keys", () => {
  it("authFailKey is a bare suffix (client prepends caliber:gw:)", () => {
    expect(authFailKey("acc-1")).toBe("authfail:acc-1");
  });
  it("authGraceKey is a bare suffix", () => {
    expect(authGraceKey("acc-1")).toBe("authgrace:acc-1");
  });
});
