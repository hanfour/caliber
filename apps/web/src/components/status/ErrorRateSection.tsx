"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const HOUR_MS = 60 * 60 * 1000;

// Start of the 24h error-rate window, as an ISO string. Floored to the current
// hour on purpose: react-query keys on this value, so a raw millisecond
// timestamp would change every render → refetch churn (staleTime=0). Hour-
// flooring makes it stable within the hour (no churn) yet still advance over
// time and on Refresh — unlike a frozen mount-time value, which would leave a
// long-open page fetching a stale window.
function windowStart(): string {
  const flooredNow = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return new Date(flooredNow - 24 * HOUR_MS).toISOString();
}

function pct(errorRequests: number, totalRequests: number): string {
  if (totalRequests <= 0) return "0%";
  return `${Math.round((errorRequests / totalRequests) * 100)}%`;
}

export function ErrorRateSection() {
  const t = useTranslations("status.errorRate");
  const tCommon = useTranslations("common");
  // Hour-floored so the query key is stable within the hour (no per-render
  // refetch) yet stays current across refreshes / long sessions.
  const { data, isLoading, error } = trpc.usage.errorSummary.useQuery({
    scope: { type: "own" },
    from: windowStart(),
  });

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : error || !data ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{pct(data.errorRequests, data.totalRequests)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("rate")}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{data.count429}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("count429")}</div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <div className="text-2xl font-semibold">{data.count5xx}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("count5xx")}</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
