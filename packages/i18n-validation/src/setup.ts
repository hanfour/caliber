import { z } from "zod";
import { createErrorMap } from "./errorMap.js";
import { loadValidationMessages, type ValidationMessages } from "./messages.js";
import { currentLocale } from "./runtime.js";
import { DEFAULT_LOCALE, type Locale } from "./locales.js";

let installed = false;

// Per-locale memoised error map. The global setErrorMap callback fires on
// every issue; we don't want to re-build the map on each call.
const cached = new Map<Locale, ReturnType<typeof createErrorMap>>();
// Lazy-loaded messages keyed by locale. Until the first eager load completes
// we fall through to the default-locale map (synchronous).
const messages = new Map<Locale, ValidationMessages>();

function getMap(locale: Locale): ReturnType<typeof createErrorMap> | null {
  const cachedMap = cached.get(locale);
  if (cachedMap) return cachedMap;
  const msgs = messages.get(locale);
  if (!msgs) return null;
  const map = createErrorMap(msgs);
  cached.set(locale, map);
  return map;
}

/**
 * Synchronous accessor for the eagerly-loaded messages cache. Returns the
 * requested locale, falls back to DEFAULT_LOCALE, or returns null if
 * `setGlobalLocaleErrorMap()` hasn't completed yet. Used by the tRPC
 * errorFormatter (which runs synchronously at response time) to translate
 * `validation.*` keys that bypass Zod's global errorMap.
 */
export function getValidationMessagesSync(
  locale: Locale,
): ValidationMessages | null {
  return messages.get(locale) ?? messages.get(DEFAULT_LOCALE) ?? null;
}

/**
 * Eagerly load every locale catalogue and install a global Zod errorMap
 * that, at issue-time, dispatches to the locale stored in AsyncLocalStorage
 * (or DEFAULT_LOCALE if outside any scope).
 *
 * Idempotent: subsequent calls are no-ops.
 */
export async function setGlobalLocaleErrorMap(): Promise<void> {
  if (installed) return;
  installed = true;
  const locales: Locale[] = ["en", "zh-TW", "zh-CN", "ja", "ko"];
  // Eager-load all five so the runtime dispatch is synchronous.
  await Promise.all(
    locales.map(async (l) => {
      messages.set(l, await loadValidationMessages(l));
    }),
  );
  z.setErrorMap((issue, ctx) => {
    const locale = currentLocale();
    const map = getMap(locale) ?? getMap(DEFAULT_LOCALE);
    if (!map) return { message: ctx.defaultError };
    return map(issue, ctx);
  });
}

// Test-only escape hatch.
export function _resetForTests(): void {
  installed = false;
  cached.clear();
  messages.clear();
}
