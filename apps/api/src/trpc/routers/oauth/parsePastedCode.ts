// Manual-paste parsing. Anthropic shows "<code>#<state>"; OpenAI codex
// loopback redirects to "http://localhost:1455/auth/callback?code=X&state=Y"
// (no local server runs — the user copies the URL from the address bar).
// A bare value with no state yields state:"" so completeOAuth rejects it
// (state CSRF check would fail anyway — see INV-O2).
export function parsePastedCode(
  pastedValue: string,
  platform: "openai" | "anthropic",
): { code: string; state: string } {
  const v = pastedValue.trim();
  if (platform === "openai" && /[?&]code=/.test(v)) {
    try {
      const u = new URL(v);
      return {
        code: u.searchParams.get("code") ?? "",
        state: u.searchParams.get("state") ?? "",
      };
    } catch {
      // not a URL — fall through to the #-split / bare handling
    }
  }
  const hashIdx = v.indexOf("#");
  if (hashIdx >= 0) {
    return { code: v.slice(0, hashIdx), state: v.slice(hashIdx + 1) };
  }
  return { code: v, state: "" };
}
