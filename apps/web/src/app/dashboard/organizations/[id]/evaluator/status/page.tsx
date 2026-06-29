"use client";

import Link from "next/link";
import { use } from "react";
import { useTranslations } from "next-intl";
import { RequirePerm } from "@/components/RequirePerm";
import { StatusCard } from "@/components/evaluator/StatusCard";
import { CostSummaryCard } from "@/components/evaluator/CostSummaryCard";

export default function EvaluatorStatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const t = useTranslations("evaluator.status");
  return (
    <RequirePerm action={{ type: "evaluator.read_status", orgId }}>
      <div className="container max-w-3xl py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </header>
        <RequirePerm action={{ type: "evaluator.view_cost", orgId }}>
          <div className="space-y-2">
            <CostSummaryCard orgId={orgId} variant="compact" />
            <div className="text-right">
              <Link
                href={`/dashboard/organizations/${orgId}/evaluator/costs`}
                className="text-sm text-primary hover:underline"
              >
                {t("viewCostDashboard")}
              </Link>
            </div>
          </div>
        </RequirePerm>
        <StatusCard orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
