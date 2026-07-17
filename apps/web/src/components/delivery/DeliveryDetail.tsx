"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { DeliveryMetricKey, DeliverySectionScore } from "@caliber/evaluator";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { scoreBadgeClass } from "../evaluator/reportDetailShared";
import {
  EvaluationWindowSelect,
  selectionToRange,
  DEFAULT_SELECTION,
  type WindowSelection,
} from "../evaluator/EvaluationWindowSelect";
import { DeliveryNarrative } from "./DeliveryNarrative";
import { DeliveryActivityList } from "./DeliveryActivityList";

// ─── Types (mirrors the jsonb shape persisted by
// apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts) ─────────────────

interface DeliveryMetricsPresent {
  windowDays: number;
  totalEvents: number;
  values: Partial<Record<DeliveryMetricKey, number>>;
  rubricVersion: string;
}

interface DeliveryMetricsNoIdentity {
  noIdentity: true;
}

type DeliveryMetricsShape = DeliveryMetricsPresent | DeliveryMetricsNoIdentity;

function isNoIdentityMetrics(metrics: unknown): metrics is DeliveryMetricsNoIdentity {
  return (
    !!metrics &&
    typeof metrics === "object" &&
    (metrics as DeliveryMetricsNoIdentity).noIdentity === true
  );
}

// Median metrics (pr_lead_time_hours_median, issue_resolution_days_median)
// render with one decimal place; count metrics render as-is.
const MEDIAN_METRIC_KEYS: ReadonlySet<string> = new Set([
  "pr_lead_time_hours_median",
  "issue_resolution_days_median",
]);

function formatMetricValue(key: string, value: number | null): string {
  if (value === null) return "—";
  return MEDIAN_METRIC_KEYS.has(key) ? value.toFixed(1) : String(value);
}

// LOCK: section/metric scores are 0-1 fractions from curveScore — render as a
// rounded percent, never multiplied by the 120-point scale or by weight.
function formatPercent(fraction: number | null): string | null {
  return fraction === null ? null : `${Math.round(fraction * 100)}%`;
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
  userId: string;
  userName?: string | null;
}

export function DeliveryDetail({ orgId, userId }: Props) {
  const t = useTranslations("evaluator.delivery");
  const tReport = useTranslations("evaluator.report");
  const tCommon = useTranslations("common");
  const utils = trpc.useUtils();

  const [sel, setSel] = useState<WindowSelection>(DEFAULT_SELECTION);
  // Memoize on `sel`: a bare `new Date()` in render changes the query key
  // every render → infinite refetch loop (same discipline as ReportDetail).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const { from, to } = selectionToRange(sel);
    return { rangeFrom: from, rangeTo: to };
  }, [sel]);

  const { data, isLoading, error } = trpc.githubDelivery.getReport.useQuery({
    orgId,
    userId,
    from: rangeFrom,
    to: rangeTo,
  });

  const generateMutation = trpc.githubDelivery.generate.useMutation({
    onSuccess: () => {
      toast.success(t("generateQueued"));
      utils.githubDelivery.getReport.invalidate();
    },
    onError: (err) => {
      const code = (err.data as { code?: string } | undefined)?.code;
      if (code === "FORBIDDEN") {
        toast.error(tCommon("insufficientPermission"));
      } else {
        toast.error(err.message);
      }
    },
  });

  const handleGenerate = () => {
    generateMutation.mutate({ orgId, userId, from: rangeFrom, to: rangeTo });
  };

  // Dual-placement precedent (ReportDetail): the generate button appears in
  // both the empty state and the full-report header, never both at once.
  const generateButton = (
    <RequirePerm action={{ type: "github.manage", orgId }}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={handleGenerate}
        disabled={generateMutation.isPending}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {t("generateBtn")}
      </Button>
    </RequirePerm>
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {t("loading")}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const code = (error.data as { code?: string } | undefined)?.code;
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {code === "NOT_FOUND" ? t("notEnabled") : error.message}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>{t("noReport")}</CardDescription>
          </div>
          <EvaluationWindowSelect value={sel} onChange={setSel} />
        </CardHeader>
        <CardContent className="flex justify-center py-6">{generateButton}</CardContent>
      </Card>
    );
  }

  const metrics = data.metrics as unknown as DeliveryMetricsShape;

  if (isNoIdentityMetrics(metrics)) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <EvaluationWindowSelect value={sel} onChange={setSel} />
        </CardHeader>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {t("noIdentity")}
        </CardContent>
      </Card>
    );
  }

  const totalScoreNum = data.totalScore === null ? null : parseFloat(data.totalScore);
  const isInsufficient = data.insufficientData || totalScoreNum === null;
  const sectionScores: DeliverySectionScore[] = Array.isArray(data.sectionScores)
    ? (data.sectionScores as DeliverySectionScore[])
    : [];

  const adjustmentValue =
    data.llmStatus === "ok" && data.llmQualityAdjustment != null
      ? parseFloat(data.llmQualityAdjustment)
      : null;
  const showLlmSkipped = data.llmStatus === "parse_error" || data.llmStatus === "budget_denied";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>
              {t("windowMeta", { days: metrics.windowDays, events: metrics.totalEvents })}
            </CardDescription>
          </div>

          <div className="flex items-start gap-3">
            <EvaluationWindowSelect value={sel} onChange={setSel} />

            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("scoreLabel")}</span>
                <span
                  className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(totalScoreNum)}`}
                >
                  {isInsufficient ? tReport("insufficientData") : totalScoreNum!.toFixed(1)}
                </span>
              </div>
              {adjustmentValue !== null && (
                <span className="text-xs text-muted-foreground">
                  {adjustmentValue >= 0 ? "+" : ""}
                  {adjustmentValue.toFixed(1)} {t("adjustmentLabel")}
                </span>
              )}
              {showLlmSkipped && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("llmSkipped", { reason: data.llmStatus as string })}
                </span>
              )}
            </div>

            {generateButton}
          </div>
        </CardHeader>
      </Card>

      {sectionScores.length > 0 && (
        <Card className="overflow-hidden">
          <CardContent className="divide-y divide-border p-0">
            {sectionScores.map((section) => {
              const sectionPct = formatPercent(section.score);
              return (
                <div key={section.key} className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{t(`section.${section.key}`)}</span>
                    {sectionPct === null ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
                        {tReport("insufficientData")}
                      </span>
                    ) : (
                      <span className="text-sm font-semibold tabular-nums">{sectionPct}</span>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {section.metrics.map((metric) => {
                      const subscorePct = formatPercent(metric.subscore);
                      return (
                        <li
                          key={metric.key}
                          className="flex items-center justify-between pl-4 text-xs text-muted-foreground"
                        >
                          <span>{t(`metric.${metric.key}`)}</span>
                          <span className="tabular-nums">
                            {formatMetricValue(metric.key, metric.value)} · {subscorePct ?? "—"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <DeliveryNarrative
        report={{
          llmStatus: data.llmStatus,
          llmNarrative: data.llmNarrative,
          llmEvidence: data.llmEvidence,
        }}
      />

      <DeliveryActivityList
        orgId={orgId}
        userId={userId}
        from={rangeFrom}
        to={rangeTo}
      />
    </div>
  );
}
