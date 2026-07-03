import { describe, it, expect } from "vitest";
import { buildEnrollArgs, deriveApiBase } from "../src/login/commands.js";

describe("deriveApiBase", () => {
  it("appends /api to a bare origin", () => {
    expect(deriveApiBase("https://x")).toBe("https://x/api");
  });

  it("appends /api after stripping a trailing slash", () => {
    expect(deriveApiBase("https://x/")).toBe("https://x/api");
  });

  it("leaves an already-/api origin unchanged", () => {
    expect(deriveApiBase("https://x/api")).toBe("https://x/api");
  });

  it("strips a trailing slash on an already-/api origin", () => {
    expect(deriveApiBase("https://x/api/")).toBe("https://x/api");
  });
});

describe("buildEnrollArgs", () => {
  it("uses --api-base-url and never --server", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net/api");
    expect(args).toContain("--api-base-url");
    expect(args).not.toContain("--server");
  });

  it("includes --yes, --watch-all, --mode full-body, --force", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net/api");
    expect(args).toContain("--yes");
    expect(args).toContain("--watch-all");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("full-body");
    // H3: re-login (after admin revoke, half-failed login, or a second run)
    // must never dead-end on the agent's "already enrolled" refusal — the
    // device-auth approval just completed IS the consent --force gates.
    expect(args).toContain("--force");
  });

  it("adds --insecure for http:// api base URLs", () => {
    const args = buildEnrollArgs("tok_abc", "http://localhost:3000/api");
    expect(args).toContain("--insecure");
  });

  it("does not add --insecure for https:// api base URLs", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net/api");
    expect(args).not.toContain("--insecure");
  });

  // M1: the enrollment token is base64url (alphabet includes "-"), so it can
  // legitimately start with "-". If it were the first positional arg, cobra
  // would parse it as an unknown flag and enroll would exit 1 — a ~1.6%
  // random login failure rate. All flags must come first, then a "--"
  // end-of-flags separator, then the token as the sole trailing positional.
  it("places all flags first, then --, then the token as the trailing positional arg", () => {
    const args = buildEnrollArgs("tok_abc", "https://caliber.miilink.net/api");
    expect(args[0]).toBe("enroll");
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBeGreaterThan(0);
    // Nothing after "--" except the token itself.
    expect(args.slice(sepIndex + 1)).toEqual(["tok_abc"]);
    // Every flag (anything starting with "-") appears before the separator.
    const flagsBeforeSep = args.slice(0, sepIndex).filter((a) => a.startsWith("--"));
    expect(flagsBeforeSep.length).toBeGreaterThan(0);
    expect(args.slice(0, sepIndex).filter((a) => a === "--").length).toBe(0);
  });

  it("keeps a leading-dash token safely after the -- separator", () => {
    const args = buildEnrollArgs("-abc123", "https://caliber.miilink.net/api");
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBeGreaterThan(0);
    expect(args[sepIndex + 1]).toBe("-abc123");
    expect(args.length).toBe(sepIndex + 2);
  });
});
