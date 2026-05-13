// Re-export from the shared package so apps/api and apps/web agree on the
// locale list, default, cookie name, and parsing helpers without one app
// depending on the other.
export {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  pickFromAcceptLanguage,
  resolveLocale,
  type Locale,
} from "@caliber/i18n-validation";

// LOCALE_LABELS stays here — it's web-only UI copy.
import type { Locale } from "@caliber/i18n-validation";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-TW": "繁體中文",
  "zh-CN": "简体中文",
  ja: "日本語",
  ko: "한국어",
};
