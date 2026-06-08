"use client";

import { useTranslations } from "next-intl";
import { toDate } from "@/lib/time";

// Renders an upstream credential's expiry as a short countdown.
// null  → "—"  (api_key upstreams have no expiry)
// past  → "Expired" (rose)
// future → "{days}d" where days = ceil(remaining / 1 day)
export function ExpiryCountdown({ expiresAt }: { expiresAt: Date | string | null | undefined }) {
  const t = useTranslations("status.expiry");
  const d = toDate(expiresAt ?? null);
  if (!d) return <span className="text-muted-foreground">{t("none")}</span>;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0)
    return <span className="text-rose-600 dark:text-rose-400">{t("expired")}</span>;
  const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return <span>{t("days", { days })}</span>;
}
