"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
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
import { EvidenceRow } from "./EvidenceRow";
import type { ScorePoint } from "./TrendChart";
import type { SignalHitDisplay } from "./EvidenceRow";

// ─── Types inferred from evaluator/engine/types.ts shape stored in jsonb ──────

interface EvidenceItem {
  requestId?: string;
  quote: string;
  offset: number;
}

interface SignalHit {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
}

interface SectionResult {
  sectionId: string;
  name: string;
  weight: number;
  standardScore: number;
  superiorScore: number;
  score: number;
  label: string;
  signals: SignalHit[];
}

// ─── Score color helpers ───────────────────────────────────────────────────────

function scoreColorClass(score: number): string {
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

function scoreBadgeClass(score: number): string {
  if (score >= 100) return "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800";
  if (score >= 80) return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800";
  return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800";
}

// ─── Section table row with expand/collapse ────────────────────────────────────

interface SectionRowProps {
  section: SectionResult;
}

function SectionRow({ section }: SectionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("evaluator.report");

  const signals: SignalHitDisplay[] = section.signals.map((s) => ({
    id: s.id,
    hit: s.hit,
    evidence: s.evidence,
  }));

  const isSuperior = section.score === section.superiorScore && section.superiorScore > section.standardScore;

  return (
    <>
      <tr
        className="border-b border-border hover:bg-accent/20 cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium text-sm">{section.name}</span>
          </div>
          <div className="ml-5.5 mt-0.5 text-[10px] font-mono text-muted-foreground">
            {section.sectionId}
          </div>
        </td>
        <td className="px-4 py-2.5 text-center">
          <span className={`text-sm font-semibold tabular-nums ${scoreColorClass(section.score)}`}>
            {section.score}
          </span>
        </td>
        <td className="px-4 py-2.5 text-center text-xs text-muted-foreground tabular-nums">
          {section.weight}%
        </td>
        <td className="px-4 py-2.5 text-center">
          {isSuperior ? (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800">
              {t("superior")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{section.label}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={4} className="p-0">
            <EvidenceRow signals={signals} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main ReportDetail component ───────────────────────────────────────────────

interface Props {
  orgId: string;
  userId: string;
  userName: string;
}

export function ReportDetail({ orgId, userId, userName }: Props) {
  const t = useTranslations("evaluator.report");
  // Memoize: a bare `new Date()` in render changes the query key every render →
  // infinite refetch loop (report never settles, API hammered).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { rangeFrom: thirtyDaysAgo.toISOString(), rangeTo: now.toISOString() };
  }, []);

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
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("evaluationTitle")}</CardTitle>
          <CardDescription>{t("thirtyDayHistory")}</CardDescription>
        </CardHeader>
        <CardContent className="py-6 text-sm text-muted-foreground text-center">
          {t("noReports")}
        </CardContent>
      </Card>
    );
  }

  // Latest report (reports ordered periodStart desc — index 0 is most recent)
  const latest = reports[0]!;
  const latestScore = parseFloat(latest.totalScore);

  // Build 30-day trend series: one point per report, oldest → newest
  const trendSeries: ScorePoint[] = [...reports]
    .reverse()
    .map((r) => ({
      date: new Date(r.periodStart).toISOString().slice(0, 10),
      score: parseFloat(r.totalScore),
    }));

  // Parse sectionScores from jsonb (stored as SectionResult[])
  const sectionScores: SectionResult[] = Array.isArray(latest.sectionScores)
    ? (latest.sectionScores as SectionResult[])
    : [];

  const hasLlmNarrative = typeof latest.llmNarrative === "string" && latest.llmNarrative.length > 0;

  return (
    <div className="space-y-6">
      {/* Header card */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("evaluationFor", { name: userName })}</CardTitle>
            <CardDescription>
              {t("thirtyDayWindow", {
                date: new Date(latest.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
            >
              {latestScore.toFixed(1)}
            </span>

            <RequirePerm
              action={{ type: "report.rerun", orgId, targetUserId: userId, periodStart: rangeFrom }}
            >
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleRerun}
                disabled={rerunMutation.isPending}
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

      {/* LLM narrative card — only when llmNarrative is present */}
      {hasLlmNarrative && (
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
                  <SectionRow key={section.sectionId} section={section} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
