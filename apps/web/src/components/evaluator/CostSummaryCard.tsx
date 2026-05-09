"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  orgId: string;
  variant?: "full" | "compact";
  className?: string;
}

export function CostSummaryCard({ orgId, variant = "full", className }: Props) {
  const t = useTranslations("evaluator.costs");
  const { data, isLoading, error } = trpc.evaluator.costSummary.useQuery({
    orgId,
  });

  const fmtUsd = (v: number | null): string => {
    if (v == null) return t("unlimited");
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(v);
  };

  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className={className}>
        <CardContent className="py-6">
          <p className="text-sm text-destructive">
            {t("loadFail", { message: error.message })}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const pct =
    data.budgetUsd != null && data.budgetUsd > 0
      ? Math.min(100, (data.currentMonthSpendUsd / data.budgetUsd) * 100)
      : 0;
  const barColor = data.halted
    ? "bg-zinc-500"
    : data.warningThresholdReached
      ? "bg-red-500"
      : pct >= 50
        ? "bg-amber-500"
        : "bg-emerald-500";

  if (variant === "compact") {
    return (
      <Card className={className}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            {t("monthlySpendCompact")}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="text-2xl font-semibold tabular-nums">
            {fmtUsd(data.currentMonthSpendUsd)}
            {data.budgetUsd != null && (
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / {fmtUsd(data.budgetUsd)}
              </span>
            )}
          </div>
          {data.budgetUsd != null && (
            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {data.halted && (
            <p className="text-xs text-amber-600 mt-2">
              {t("haltedCompact")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const monthLabel = new Date().toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>
          {t("thisMonthHeading", { month: monthLabel })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.halted && (
          <div className="text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded px-3 py-2">
            {t("haltedNotice")}
          </div>
        )}
        {data.warningThresholdReached && !data.halted && (
          <div className="text-sm border border-red-300 bg-red-50 text-red-900 rounded px-3 py-2">
            {t("warning80")}
          </div>
        )}

        <div>
          <div className="text-3xl font-semibold tabular-nums">
            {fmtUsd(data.currentMonthSpendUsd)}
            {data.budgetUsd != null && (
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                / {fmtUsd(data.budgetUsd)}
              </span>
            )}
          </div>
          {data.budgetUsd != null && (
            <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full ${barColor} transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 mt-3 text-sm">
            <div>
              <div className="text-muted-foreground">{t("remaining")}</div>
              <div className="font-medium tabular-nums">
                {data.remainingUsd == null
                  ? t("unlimited")
                  : fmtUsd(data.remainingUsd)}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">
                {t("projected")}
              </div>
              <div className="font-medium tabular-nums">
                {fmtUsd(data.projectedEndOfMonthUsd)}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
