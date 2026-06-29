"use client";

import { use } from "react";
import { useTranslations } from "next-intl";
import { RequirePerm } from "@/components/RequirePerm";
import { CostSummaryCard } from "@/components/evaluator/CostSummaryCard";
import { CostBreakdownTable } from "@/components/evaluator/CostBreakdownTable";
import { HistoricalSpendChart } from "@/components/evaluator/HistoricalSpendChart";
import { trpc } from "@/lib/trpc/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function CostDashboardContent({ orgId }: { orgId: string }) {
  const t = useTranslations("evaluator.costs");
  const { data } = trpc.evaluator.costSummary.useQuery({ orgId });

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <CostSummaryCard orgId={orgId} variant="full" />

      <Card>
        <CardHeader>
          <CardTitle>{t("breakdownTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-6">
          {data && (
            <>
              <CostBreakdownTable
                title={t("byTask")}
                rows={[
                  {
                    label: t("tasks.facetExtraction"),
                    calls: data.breakdown.facetExtraction.calls,
                    costUsd: data.breakdown.facetExtraction.costUsd,
                  },
                  {
                    label: t("tasks.deepAnalysis"),
                    calls: data.breakdown.deepAnalysis.calls,
                    costUsd: data.breakdown.deepAnalysis.costUsd,
                  },
                ]}
              />
              <CostBreakdownTable
                title={t("byModel")}
                rows={data.breakdownByModel.map((m) => ({
                  label: m.model,
                  calls: m.calls,
                  costUsd: m.costUsd,
                }))}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("last6Months")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data && <HistoricalSpendChart months={data.historicalMonths} />}
        </CardContent>
      </Card>
    </div>
  );
}

export default function CostDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  return (
    <RequirePerm action={{ type: "evaluator.view_cost", orgId }}>
      <CostDashboardContent orgId={orgId} />
    </RequirePerm>
  );
}
