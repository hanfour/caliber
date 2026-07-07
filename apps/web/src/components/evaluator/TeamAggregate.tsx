"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TrendChart } from "./TrendChart";
import type { ScorePoint } from "./TrendChart";

// ─── Score colour helpers (mirrors ReportDetail) ─────────────────────────────

function scoreColorClass(score: number): string {
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

function scoreBadgeClass(score: number): string {
  if (score >= 100)
    return "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800";
  if (score >= 80)
    return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800";
  return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800";
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
  teamId: string;
  teamName: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TeamAggregate({ orgId, teamId, teamName }: Props) {
  const t = useTranslations("evaluator.leaderboard");
  // Memoize: bare `new Date()` in render → query key churns every render →
  // infinite refetch loop.
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { rangeFrom: thirtyDaysAgo.toISOString(), rangeTo: now.toISOString() };
  }, []);

  const { data: reports, isLoading, error } = trpc.reports.getTeam.useQuery({
    orgId,
    teamId,
    range: { from: rangeFrom, to: rangeTo },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("loadingTeam")}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {error.message}
        </CardContent>
      </Card>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("teamEvaluationTitle")}</CardTitle>
          <CardDescription>{t("thirtyDayHistory")}</CardDescription>
        </CardHeader>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          {t("noReports")}
        </CardContent>
      </Card>
    );
  }

  // Group reports by date (YYYY-MM-DD) to compute daily team averages.
  // Reports are ordered periodStart desc from the server.
  const byDate = new Map<string, number[]>();
  for (const r of reports) {
    const day = new Date(r.periodStart).toISOString().slice(0, 10);
    const existing = byDate.get(day) ?? [];
    byDate.set(day, [...existing, parseFloat(r.totalScore)]);
  }

  // Build trend series oldest → newest
  const trendSeries: ScorePoint[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, scores]) => ({
      date,
      score:
        Math.round(
          (scores.reduce((sum, s) => sum + s, 0) / scores.length) * 10,
        ) / 10,
    }));

  // Latest day's team average
  const latestEntry = trendSeries[trendSeries.length - 1];
  const latestAvg = latestEntry?.score ?? 0;

  // Report count + unique members
  const reportCount = reports.length;
  const uniqueMembers = new Set(reports.map((r) => r.userId)).size;

  // Pick the right pluralized window summary.
  const windowSummary =
    reportCount === 1 && uniqueMembers === 1
      ? t("thirtyDayWindowSummaryBothOne")
      : reportCount === 1
        ? t("thirtyDayWindowSummaryOne", { members: uniqueMembers })
        : uniqueMembers === 1
          ? t("thirtyDayWindowSummaryOneMember", { reports: reportCount })
          : t("thirtyDayWindowSummary", {
              reports: reportCount,
              members: uniqueMembers,
            });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">
            {t("teamEvaluationFor", { name: teamName })}
          </CardTitle>
          <CardDescription>
            {windowSummary}
          </CardDescription>
        </div>

        <span
          className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(latestAvg)}`}
        >
          {latestAvg.toFixed(1)}
        </span>
      </CardHeader>

      <CardContent>
        <TrendChart series={trendSeries} />
      </CardContent>
    </Card>
  );
}
