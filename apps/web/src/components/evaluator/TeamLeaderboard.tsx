"use client";

import { useMemo } from "react";
import Link from "next/link";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

// ─── Score colour helpers ─────────────────────────────────────────────────────

function scoreColorClass(score: number | null): string {
  if (score === null) return "text-zinc-500 dark:text-zinc-400";
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

// ─── Per-member row data ──────────────────────────────────────────────────────

interface MemberRow {
  userId: string;
  displayName: string;
  latestScore: number | null;
  previousScore: number | null;
}

type TrendDirection = "up" | "down" | "flat";

function trendDirection(
  latest: number | null,
  previous: number | null,
): TrendDirection {
  if (previous === null || latest === null) return "flat";
  const delta = latest - previous;
  if (delta > 1) return "up";
  if (delta < -1) return "down";
  return "flat";
}

function TrendArrow({ direction }: { direction: TrendDirection }) {
  const t = useTranslations("evaluator.leaderboard");
  if (direction === "up")
    return (
      <TrendingUp className="h-3.5 w-3.5 text-emerald-500" aria-label={t("trendUp")} />
    );
  if (direction === "down")
    return (
      <TrendingDown className="h-3.5 w-3.5 text-red-500" aria-label={t("trendDown")} />
    );
  return (
    <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("trendFlat")} />
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
  teamId: string;
  /** Pre-fetched members with display names — passed from parent to avoid N+1. */
  members: Array<{ id: string; name: string | null; email: string }>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TeamLeaderboard({ orgId, teamId, members }: Props) {
  const t = useTranslations("evaluator.leaderboard");
  const tReport = useTranslations("evaluator.report");
  // Memoize: bare `new Date()` in render → query keys churn every render →
  // infinite refetch loop across all the leaderboard queries below.
  const { rangeFrom, rangeTo, prevFrom, prevTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    return {
      rangeFrom: thirtyDaysAgo.toISOString(),
      rangeTo: now.toISOString(),
      prevFrom: sixtyDaysAgo.toISOString(),
      prevTo: thirtyDaysAgo.toISOString(),
    };
  }, []);

  const { data: settings, isLoading: settingsLoading } =
    trpc.contentCapture.getSettings.useQuery({ orgId });

  const { data: currentReports, isLoading: currentLoading } =
    trpc.reports.getTeam.useQuery({
      orgId,
      teamId,
      range: { from: rangeFrom, to: rangeTo },
    });

  const { data: prevReports, isLoading: prevLoading } =
    trpc.reports.getTeam.useQuery({
      orgId,
      teamId,
      range: { from: prevFrom, to: prevTo },
    });

  const isLoading = settingsLoading || currentLoading || prevLoading;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("loading")}
        </CardContent>
      </Card>
    );
  }

  const leaderboardEnabled = settings?.leaderboardEnabled ?? false;

  // Build a userId → displayName map from the passed members list
  const nameMap = new Map<string, string>(
    members.map((m) => [m.id, m.name ?? m.email]),
  );

  // Per-member latest score: most recent report per userId in current window
  const latestScoreByUser = new Map<string, number | null>();
  if (currentReports) {
    // Reports are periodStart desc — first seen per userId is the latest
    for (const r of currentReports) {
      if (!latestScoreByUser.has(r.userId)) {
        latestScoreByUser.set(
          r.userId,
          r.totalScore === null ? null : parseFloat(r.totalScore),
        );
      }
    }
  }

  // Per-member previous-period latest score
  const prevScoreByUser = new Map<string, number | null>();
  if (prevReports) {
    for (const r of prevReports) {
      if (!prevScoreByUser.has(r.userId)) {
        prevScoreByUser.set(
          r.userId,
          r.totalScore === null ? null : parseFloat(r.totalScore),
        );
      }
    }
  }

  // Only include members who have at least one report in the current window
  const rows: MemberRow[] = [...latestScoreByUser.entries()].map(
    ([userId, latestScore]) => ({
      userId,
      displayName: nameMap.get(userId) ?? userId.slice(0, 8),
      latestScore,
      previousScore: prevScoreByUser.get(userId) ?? null,
    }),
  );

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {leaderboardEnabled ? t("leaderboardTitle") : t("memberScoresTitle")}
          </CardTitle>
          <CardDescription>{t("thirtyDayHistory")}</CardDescription>
        </CardHeader>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          {t("noIndividualReports")}
        </CardContent>
      </Card>
    );
  }

  // Sort: ranked (desc by score, null scores sink to the bottom) when
  // leaderboard enabled, alphabetical otherwise.
  const sorted = leaderboardEnabled
    ? [...rows].sort((a, b) => {
        if (a.latestScore === null && b.latestScore === null) return 0;
        if (a.latestScore === null) return 1;
        if (b.latestScore === null) return -1;
        return b.latestScore - a.latestScore;
      })
    : [...rows].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, {
          sensitivity: "base",
        }),
      );

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="text-base">
          {leaderboardEnabled ? t("leaderboardTitle") : t("memberScoresTitle")}
        </CardTitle>
        <CardDescription>
          {leaderboardEnabled
            ? t("rankedSubtitle")
            : t("alphabeticalSubtitle")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              {leaderboardEnabled && (
                <th className="w-10 px-4 py-2 text-center font-medium">{t("rank")}</th>
              )}
              <th className="px-4 py-2 text-left font-medium">{t("member")}</th>
              <th className="px-4 py-2 text-center font-medium">{t("score")}</th>
              <th className="px-4 py-2 text-center font-medium">{t("trend")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, idx) => {
              const direction = trendDirection(row.latestScore, row.previousScore);
              const initials = row.displayName.charAt(0).toUpperCase();

              return (
                <tr
                  key={row.userId}
                  className="border-b border-border last:border-0 hover:bg-accent/20"
                >
                  {leaderboardEnabled && (
                    <td className="px-4 py-2.5 text-center tabular-nums text-xs font-semibold text-muted-foreground">
                      {idx + 1}
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="bg-primary/10 text-[11px] font-semibold text-primary">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      <Link
                        href={`/dashboard/organizations/${orgId}/members/${row.userId}`}
                        className="font-medium hover:underline"
                      >
                        {row.displayName}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {row.latestScore === null ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
                        {tReport("insufficientData")}
                      </span>
                    ) : (
                      <span
                        className={`tabular-nums font-semibold ${scoreColorClass(row.latestScore)}`}
                      >
                        {row.latestScore.toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <div className="flex items-center justify-center">
                      <TrendArrow direction={direction} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
