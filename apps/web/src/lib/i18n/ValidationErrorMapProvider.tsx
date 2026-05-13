"use client";

import { useEffect, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { z } from "zod";
import {
  createErrorMap,
  loadValidationMessages,
  isLocale,
  DEFAULT_LOCALE,
} from "@caliber/i18n-validation";

/**
 * Re-installs Zod's global error map whenever the active next-intl locale
 * changes. Forms that use `zodResolver` pick up the new map automatically
 * on their next parse, so locale switches between sessions surface in
 * react-hook-form error messages without per-form changes.
 *
 * On first mount the map is installed asynchronously (we await the JSON
 * import). Until that resolves Zod uses its built-in English defaults —
 * acceptable for the initial paint; the documented transitional state.
 */
export function ValidationErrorMapProvider({
  children,
}: {
  children: ReactNode;
}) {
  const rawLocale = useLocale();
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  useEffect(() => {
    let cancelled = false;
    void loadValidationMessages(locale).then((messages) => {
      if (cancelled) return;
      z.setErrorMap(createErrorMap(messages));
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
  return <>{children}</>;
}
