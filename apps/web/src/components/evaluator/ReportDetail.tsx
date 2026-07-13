"use client";

import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
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
import { TrendChart } from "./TrendChart";
import type { ScorePoint } from "./TrendChart";
import { SectionRow, scoreBadgeClass, type SectionResult } from "./reportDetailShared";
import { DataProvenanceCard } from "./DataProvenanceCard";
import { FacetSummaryCard } from "./FacetSummaryCard";
import { LlmEvidenceList } from "./LlmEvidenceList";
import { GeneratedAudienceReport } from "./GeneratedAudienceReport";
import {
  EvaluationWindowSelect,
  selectionToRange,
  rangeDays,
  RERUN_MAX_DAYS,
  DEFAULT_SELECTION,
  lastCompletedQuarter,
  type WindowSelection,
} from "./EvaluationWindowSelect";
import type { RubricSignal } from "./rubricThreshold";

// ─── Main ReportDetail component ───────────────────────────────────────────────

interface Props {
  orgId: string;
  userId: string;
  userName: string;
}

export function ReportDetail({ orgId, userId, userName }: Props) {
  const t = useTranslations("evaluator.report");
  const [sel, setSel] = useState<WindowSelection>(DEFAULT_SELECTION);
  // Memoize on `sel`: a bare `new Date()` in render changes the query key every
  // render → infinite refetch loop (report never settles, API hammered).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const { from, to } = selectionToRange(sel);
    return { rangeFrom: from, rangeTo: to };
  }, [sel]);
  // The rerun backend rejects windows > 92 days; longer custom ranges stay
  // view-only. +0.01 tolerates float drift on the 92-day edge.
  const rerunAllowed = rangeDays(rangeFrom, rangeTo) <= RERUN_MAX_DAYS + 0.01;
  const quarterName = (() => {
    const q = lastCompletedQuarter();
    return `${q.year} Q${q.quarter}`;
  })();
  const windowLabelKey =
    sel.mode === "custom"
      ? "windowUpdatedCustom"
      : sel.mode === "quarter"
        ? "windowUpdatedQuarter"
        : "windowUpdated";
  const windowLabelValues: Record<string, string | number> =
    sel.mode === "preset" ? { days: sel.days } : sel.mode === "quarter" ? { quarter: quarterName } : {};

  const { data: reports, isLoading, error } = trpc.reports.getUser.useQuery({
    orgId,
    userId,
    range: { from: rangeFrom, to: rangeTo },
  });

  const rerunMutation = trpc.reports.rerun.useMutation({
    onSuccess: (result) => {
      if (result.testMode) {
        toast.info(t("rerunQueuedToast"));
      } else {
        toast.success(t("rerunEnqueuedToast", { count: result.enqueued }));
      }
    },
    onError: (err) => {
      toast.error(err.message ?? t("rerunFailed"));
    },
  });

  const latestRubricId = reports?.[0]?.rubricId ?? null;
  const { data: rubric } = trpc.rubrics.get.useQuery(
    { rubricId: latestRubricId ?? "" },
    { enabled: !!latestRubricId },
  );

  const handleRerun = () => {
    rerunMutation.mutate({
      orgId,
      scope: "user",
      targetId: userId,
      periodStart: rangeFrom,
      periodEnd: rangeTo,
    });
  };

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
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {error.message}
        </CardContent>
      </Card>
    );
  }

  if (!reports || reports.length === 0) {
    const emptyDesc =
      sel.mode === "custom"
        ? t("windowHistoryCustom")
        : sel.mode === "quarter"
          ? t("windowHistoryQuarter", { quarter: quarterName })
          : t("windowHistory", { days: sel.days });
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("evaluationTitle")}</CardTitle>
            <CardDescription>{emptyDesc}</CardDescription>
          </div>
          <EvaluationWindowSelect value={sel} onChange={setSel} />
        </CardHeader>
        <CardContent className="space-y-3 py-6 text-center text-sm text-muted-foreground">
          <p>{t("noReports")}</p>
          <RequirePerm
            action={{ type: "report.rerun", orgId, targetUserId: userId, periodStart: rangeFrom }}
          >
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleRerun}
              disabled={rerunMutation.isPending || !rerunAllowed}
              title={!rerunAllowed ? t("rerunMaxWindow", { days: RERUN_MAX_DAYS }) : undefined}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {rerunMutation.isPending ? t("queueing") : t("generateBtn")}
            </Button>
          </RequirePerm>
        </CardContent>
      </Card>
    );
  }

  // Latest report (reports ordered periodStart desc — index 0 is most recent)
  const latest = reports[0]!;
  const latestScore = latest.totalScore === null ? null : parseFloat(latest.totalScore);
  const isInsufficientData = latestScore === null || latest.insufficientData;

  // Build 30-day trend series: one point per report, oldest → newest.
  // Reports with a null/insufficient score are skipped — there's nothing to plot.
  const trendSeries: ScorePoint[] = [...reports]
    .reverse()
    .filter((r) => r.totalScore !== null)
    .map((r) => ({
      date: new Date(r.periodStart).toISOString().slice(0, 10),
      score: parseFloat(r.totalScore as string),
    }));

  // Parse sectionScores from jsonb (stored as SectionResult[])
  const sectionScores: SectionResult[] = Array.isArray(latest.sectionScores)
    ? (latest.sectionScores as SectionResult[])
    : [];

  const hasLlmNarrative = typeof latest.llmNarrative === "string" && latest.llmNarrative.length > 0;
  const hasGeneratedReport = latest.generatedReport != null;

  const rubricSectionsById: Record<string, { signals: RubricSignal[] }> = {};
  const def = rubric?.definition as { sections?: Array<{ id: string; signals: RubricSignal[] }> } | undefined;
  for (const s of def?.sections ?? []) {
    rubricSectionsById[s.id] = { signals: s.signals };
  }
  const period = (latest.signalsSummary as { period?: { requestCount?: number; bodyCount?: number } } | null)?.period ?? null;

  return (
    <div className="space-y-6">
      {/* Header card */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("evaluationFor", { name: userName })}</CardTitle>
            <CardDescription>
              {t(windowLabelKey, {
                ...windowLabelValues,
                date: new Date(latest.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>

          <div className="flex items-start gap-3">
            <EvaluationWindowSelect value={sel} onChange={setSel} />
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
            >
              {isInsufficientData ? t("insufficientData") : latestScore!.toFixed(1)}
            </span>

            <RequirePerm
              action={{ type: "report.rerun", orgId, targetUserId: userId, periodStart: rangeFrom }}
            >
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleRerun}
                disabled={rerunMutation.isPending || !rerunAllowed}
                title={!rerunAllowed ? t("rerunMaxWindow", { days: RERUN_MAX_DAYS }) : undefined}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {rerunMutation.isPending ? t("queueing") : t("rerunBtn")}
              </Button>
            </RequirePerm>
          </div>
        </CardHeader>

        <CardContent>
          <TrendChart series={trendSeries} />
        </CardContent>
      </Card>

      <GeneratedAudienceReport
        audience={latest.reportAudience}
        report={latest.generatedReport}
        model={latest.llmModel}
        generatedAt={latest.llmCalledAt}
      />

      {/* LLM narrative card — only when llmNarrative is present */}
      {!hasGeneratedReport && hasLlmNarrative && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">{t("aiNarrative")}</CardTitle>
            <CardDescription className="text-xs">
              {latest.llmCalledAt
                ? t("generatedByDate", {
                    model: latest.llmModel ?? "LLM",
                    date: new Date(latest.llmCalledAt).toLocaleDateString(),
                  })
                : t("generatedBy", { model: latest.llmModel ?? "LLM" })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {latest.llmNarrative}
            </p>
          </CardContent>
        </Card>
      )}

      <LlmEvidenceList evidence={latest.llmEvidence} />

      {/* Section scores table */}
      {sectionScores.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">{t("sectionScores")}</CardTitle>
            <CardDescription className="text-xs">
              {t("clickToExpand")}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">{t("section")}</th>
                  <th className="px-4 py-2 text-center font-medium">{t("score")}</th>
                  <th className="px-4 py-2 text-center font-medium">{t("weight")}</th>
                  <th className="px-4 py-2 text-center font-medium">{t("label")}</th>
                </tr>
              </thead>
              <tbody>
                {sectionScores.map((section) => (
                  <SectionRow
                    key={section.sectionId}
                    section={section}
                    rubricSection={rubricSectionsById[section.sectionId]}
                  />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <DataProvenanceCard
        sourceBreakdown={latest.sourceBreakdown as never}
        dataQuality={latest.dataQuality as never}
        period={period}
      />

      <FacetSummaryCard
        orgId={orgId}
        userId={userId}
        rangeFrom={rangeFrom}
        rangeTo={rangeTo}
      />
    </div>
  );
}
