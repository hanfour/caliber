import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  LOCALE_COOKIE,
  resolveLocale,
  type Locale,
} from "@caliber/i18n-validation";

/**
 * Resolve the active locale per request via the shared resolver:
 *   1. user-set cookie (`NEXT_LOCALE`) — highest priority
 *   2. `Accept-Language` header
 *   3. `DEFAULT_LOCALE` fallback
 *
 * URL-based routing (`/[locale]/...`) was deliberately avoided — every
 * existing path/bookmark continues to resolve and only the rendered
 * strings change.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale: Locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
