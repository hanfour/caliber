import { describe, it, expect } from "vitest";
import { buildEnrollArgs } from "../src/login/commands.js";

describe("buildEnrollArgs", () => {
  it("uses --api-base-url and never --server", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net");
    expect(args).toContain("--api-base-url");
    expect(args).not.toContain("--server");
  });

  it("includes --yes, --watch-all, --mode full-body", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net");
    expect(args).toContain("--yes");
    expect(args).toContain("--watch-all");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("full-body");
  });

  it("adds --insecure for http:// server URLs", () => {
    const args = buildEnrollArgs("tok_abc", "http://localhost:3000");
    expect(args).toContain("--insecure");
  });

  it("does not add --insecure for https:// server URLs", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net");
    expect(args).not.toContain("--insecure");
  });

  it("places the token as the positional arg right after enroll", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net");
    expect(args[0]).toBe("enroll");
    expect(args[1]).toBe("tok_abc");
  });
});
