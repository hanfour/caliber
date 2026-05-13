import { describe, it, expect } from "vitest";
import { LOCALES, type Locale } from "../src/locales.js";
import { loadValidationMessages } from "../src/messages.js";

// Recursively enumerate every leaf key path in a nested object.
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out.push(...leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return out.sort();
}

describe("locale catalogue parity", () => {
  it("every locale has the same key set as en", async () => {
    const en = await loadValidationMessages("en");
    const enKeys = leafPaths(en);
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const messages = await loadValidationMessages(locale as Locale);
      const localeKeys = leafPaths(messages);
      const missing = enKeys.filter((k) => !localeKeys.includes(k));
      const extra = localeKeys.filter((k) => !enKeys.includes(k));
      expect(
        { locale, missing, extra },
        `Locale ${locale} diverges from en`,
      ).toEqual({ locale, missing: [], extra: [] });
    }
  });
});
