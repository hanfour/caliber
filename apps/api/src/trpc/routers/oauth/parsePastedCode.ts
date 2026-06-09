// Manual-paste parsing. Both platforms use a loopback redirect
// ("http://localhost:<port>/callback?code=X&state=Y") — no local server runs,
// so the user copies the URL from the address bar after the "connection
// refused" page. Anthropic also accepts the console "<code>#<state>" form (the
// callback page that displays the code), so the #-split is kept as a fallback.
// A bare value with no state yields state:"" so completeOAuth rejects it
// (state CSRF check would fail anyway — see INV-O2).
export function parsePastedCode(
  pastedValue: string,
  _platform: "openai" | "anthropic",
): { code: string; state: string } {
  const v = pastedValue.trim();
  // A pasted callback URL takes precedence for either platform.
  if (/[?&]code=/.test(v)) {
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
