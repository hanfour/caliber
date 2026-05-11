// Single source of truth for the locales caliber ships with.
//
// Adding a new locale requires:
//   1. an entry here (and in `LOCALE_LABELS`),
//   2. a matching `messages/<locale>.json` catalogue,
//   3. nothing else — the request config and the switcher pick it
//      up from this list automatically.

export const LOCALES = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Cookie name for the user's selected locale. Reading + writing are
// done in two places (server `request.ts` reads, client
// `LocaleSwitcher` writes) so the cookie name is centralised here.
export const LOCALE_COOKIE = "NEXT_LOCALE";

// User-facing names for the switcher. Native script for each so a
// reader who can't read English can still recognise their own.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
};

export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (LOCALES as readonly string[]).includes(value);
}
