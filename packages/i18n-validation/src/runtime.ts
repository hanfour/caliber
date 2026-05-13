import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LOCALE, type Locale } from "./locales.js";

// One process-wide store. Fastify's request lifecycle, tRPC handler chains,
// and any synchronous/async work inside `runWithLocale` all see the same
// locale via Node's AsyncLocalStorage propagation.
const localeStorage = new AsyncLocalStorage<Locale>();

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return localeStorage.run(locale, fn);
}

export function currentLocale(): Locale {
  return localeStorage.getStore() ?? DEFAULT_LOCALE;
}
