"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Start of the 24h error-rate window, as an ISO string. Must be memoized at the
// call site: react-query keys on the input, and a fresh millisecond timestamp
// each render would change the key every render → refetch churn (staleTime=0).
function since24h(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function pct(errorRequests: number, totalRequests: number): string {
  if (totalRequests <= 0) return "0%";
  return `${Math.round((errorRequests / totalRequests) * 100)}%`;
}

export function ErrorRateSection() {
  const t = useTranslations("status.errorRate");
  const tCommon = useTranslations("common");
  // Compute the window start once per mount so the query key stays stable.
  const from = useMemo(() => since24h(), []);
  const { data, isLoading, error } = trpc.usage.errorSummary.useQuery({
    scope: { type: "own" },
    from,
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
