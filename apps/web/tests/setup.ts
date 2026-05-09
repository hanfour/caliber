import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import enMessages from "../messages/en.json";

afterEach(() => {
  cleanup();
});

// Component tests render in isolation without a NextIntlClientProvider.
// Stub `next-intl`'s hooks against the source-of-truth English catalogue
// so `t('keypath')` returns the actual rendered string and existing
// `getByText('Loading…')`-style assertions keep working.
function lookup(path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, enMessages);
}

function format(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return out;
}

vi.mock("next-intl", () => ({
  useTranslations: (namespace?: string) =>
    Object.assign(
      (key: string, vars?: Record<string, unknown>) => {
        const full = namespace ? `${namespace}.${key}` : key;
        const value = lookup(full);
        return typeof value === "string" ? format(value, vars) : full;
      },
      { rich: (key: string) => key },
    ),
  useLocale: () => "en",
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
