"use client";

import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { toDate } from "@/lib/time";
import { formatUsd } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ListRow = inferRouterOutputs<AppRouter>["usage"]["list"]["items"][number];

const RECENT_LIMIT = 10;

function formatTime(ts: Date | string | null): string {
  const d = toDate(ts);
  return d ? d.toLocaleString() : "—";
}

export function RecentActivitySection() {
  const t = useTranslations("status.activity");
  const tCommon = useTranslations("common");
  const summary = trpc.usage.summary.useQuery({ scope: { type: "own" } });
  const list = trpc.usage.list.useQuery({ scope: { type: "own" }, page: 1, pageSize: RECENT_LIMIT });

  const items: ListRow[] = list.data?.items ?? [];

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {summary.error ? (
          <p className="mb-3 text-xs text-destructive">{t("summaryLoadError")}</p>
        ) : summary.data ? (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("summary", { requests: summary.data.totalRequests, cost: formatUsd(summary.data.totalCostUsd) })}
          </p>
        ) : null}
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : list.error || !list.data ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colTime")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colSurface")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colModel")}</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("colLatency")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("colCost")}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t("colEstCost")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row: ListRow) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatTime(row.createdAt)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.surface}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.requestedModel}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.statusCode}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">{row.durationMs}ms</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatUsd(row.totalCost)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{formatUsd(row.notionalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
