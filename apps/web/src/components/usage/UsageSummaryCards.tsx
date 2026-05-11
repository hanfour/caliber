"use client";

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { Card } from "@/components/ui/card";
import { formatUsd } from "@/lib/money";

type Summary = inferRouterOutputs<AppRouter>["usage"]["summary"];

interface Props {
  summary: Summary | undefined;
  isLoading: boolean;
}

interface Kpi {
  label: string;
  value: string;
  subtext?: string;
}

function buildKpis(summary: Summary | undefined): Kpi[] {
  if (!summary) {
    return [
      { label: "Requests", value: "—" },
      { label: "Total cost", value: "—" },
      { label: "Total tokens", value: "—" },
      { label: "Top model", value: "—" },
    ];
  }
  const top = summary.byModel[0];
  return [
    { label: "Requests", value: summary.totalRequests.toLocaleString() },
    { label: "Total cost", value: formatUsd(summary.totalCostUsd) },
    {
      label: "Total tokens",
      value: (
        summary.totalInputTokens + summary.totalOutputTokens
      ).toLocaleString(),
    },
    {
      label: "Top model",
      value: top?.model ?? "—",
      subtext: top ? formatUsd(top.costUsd) : undefined,
    },
  ];
}

export function UsageSummaryCards({ summary, isLoading }: Props) {
  const kpis = buildKpis(isLoading ? undefined : summary);
  return (
    <div className="grid gap-4 md:grid-cols-4">
      {kpis.map((k) => (
        <Card key={k.label} className="shadow-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {k.label}
          </div>
          <div className="mt-1.5 truncate font-mono text-xl font-semibold">
            {k.value}
          </div>
          {k.subtext && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {k.subtext}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
