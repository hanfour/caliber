import { describe, it, expect } from "vitest";
import { keys } from "../../src/redis/keys.js";

describe("keys", () => {
  it("slots user scope", () => {
    expect(keys.slots("user", "abc-123")).toBe("slots:user:abc-123");
  });

  it("slots account scope", () => {
    expect(keys.slots("account", "acct-456")).toBe("slots:account:acct-456");
  });

  it("wait key", () => {
    expect(keys.wait("user-789")).toBe("wait:user:user-789");
  });

  it("idem key", () => {
    expect(keys.idem("req-abc")).toBe("idem:req-abc");
  });


  it("state key", () => {
    expect(keys.state("acct-x")).toBe("state:account:acct-x");
  });

  it("oauthRefresh key", () => {
    expect(keys.oauthRefresh("acct-y")).toBe("oauth-refresh:acct-y");
  });
});
