// Single source of truth for the locales Caliber ships with.
// Lifted from apps/web/src/i18n/locales.ts so apps/api can share it
// without reverse-depending on apps/web.

export const LOCALES = ["en", "zh-TW", "zh-CN", "ja", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | null | undefined): value is Locale {
  return (
    value !== null &&
    value !== undefined &&
    (LOCALES as readonly string[]).includes(value)
  );
}

export function pickFromAcceptLanguage(
  headerValue: string | null,
): Locale | null {
  if (!headerValue) return null;
  const tags = headerValue
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter((t): t is string => Boolean(t));
  for (const tag of tags) {
    if (isLocale(tag)) return tag;
    const primary = tag.split("-")[0];
    if (!primary) continue;
    const fallback = LOCALES.find(
      (l) => l.startsWith(primary + "-") || l === primary,
    );
    if (fallback) return fallback;
  }
  return null;
}

export interface ResolveLocaleInput {
  cookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
}

export function resolveLocale({
  cookie,
  acceptLanguage,
}: ResolveLocaleInput): Locale {
  if (isLocale(cookie)) return cookie;
  const fromAccept = pickFromAcceptLanguage(acceptLanguage ?? null);
  return fromAccept ?? DEFAULT_LOCALE;
}
