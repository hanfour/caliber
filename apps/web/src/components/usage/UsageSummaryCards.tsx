"use client";

import { useTranslations } from "next-intl";
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

function buildKpis(
  summary: Summary | undefined,
  replayCostLabel: string,
  replayCostSubtext: string,
): Kpi[] {
  if (!summary) {
    return [
      { label: "Requests", value: "—" },
      { label: "Total cost", value: "—" },
      { label: "Total tokens", value: "—" },
      { label: "Top model", value: "—" },
      { label: replayCostLabel, value: "—" },
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
    // Replay spend broken out as its own tile — never netted out of "Total
    // cost" above (replays are real, billed gateway calls). This is the
    // single UI surface for usage.summary.replayCostUsd (single-request-
    // replay Task 10): without it, replay spend is computed server-side but
    // never visible anywhere a reader comparing costs would actually see it.
    {
      label: replayCostLabel,
      value: formatUsd(summary.replayCostUsd),
      subtext: replayCostSubtext,
    },
  ];
}

export function UsageSummaryCards({ summary, isLoading }: Props) {
  const t = useTranslations("usage.metrics");
  const kpis = buildKpis(
    isLoading ? undefined : summary,
    t("replayCost"),
    t("replayCostSubtext"),
  );
  return (
    <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
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
