import { describe, it, expect } from "vitest";
import { parsePastedCode } from "../../src/trpc/routers/oauth/parsePastedCode.js";

describe("parsePastedCode", () => {
  it("anthropic: splits code#state", () => {
    expect(parsePastedCode("abc#xyz", "anthropic")).toEqual({ code: "abc", state: "xyz" });
  });
  it("anthropic: bare value -> empty state (rejected downstream)", () => {
    expect(parsePastedCode("abc", "anthropic")).toEqual({ code: "abc", state: "" });
  });
  it("anthropic: parses code+state from loopback callback URL", () => {
    // Loopback flow: claude.ai redirects to http://localhost:<port>/callback
    // (no local server → "connection refused"), and the user copies the URL
    // from the address bar. URL form takes precedence over the #-split.
    expect(
      parsePastedCode(
        "http://localhost:54545/callback?code=X&state=Y",
        "anthropic",
      ),
    ).toEqual({ code: "X", state: "Y" });
  });
  it("openai: parses code+state from loopback URL", () => {
    expect(parsePastedCode("http://localhost:1455/auth/callback?code=X&state=Y", "openai")).toEqual({ code: "X", state: "Y" });
  });
  it("openai: bare code -> empty state (rejected downstream)", () => {
    expect(parsePastedCode("rawcode", "openai")).toEqual({ code: "rawcode", state: "" });
  });
  it("trims surrounding whitespace", () => {
    expect(parsePastedCode("  a#b  ", "anthropic")).toEqual({ code: "a", state: "b" });
  });
});
