"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { RequirePerm } from "@/components/RequirePerm";

interface MemberScoreCellProps {
  orgId: string;
  userId: string;
}

function scoreColorClass(score: number): string {
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

function ScoreCellContent({ orgId, userId }: MemberScoreCellProps) {
  // Memoize the range: a bare `new Date()` in render produces a new ISO string
  // every render → the tRPC query key changes every render → infinite refetch
  // loop (the score stays stuck at "…" and the API is hammered).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { rangeFrom: sevenDaysAgo.toISOString(), rangeTo: now.toISOString() };
  }, []);

  const { data: reports, isLoading } = trpc.reports.getUser.useQuery({
    orgId,
    userId,
    range: { from: rangeFrom, to: rangeTo },
  });

  if (isLoading) {
    return <span className="text-xs text-muted-foreground">…</span>;
  }

  if (!reports || reports.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  // Latest report is at index 0 (ordered by periodStart desc)
  const latest = reports[0]!;
  const latestScore = parseFloat(latest.totalScore);

  return (
    <span
      className={`text-sm font-semibold tabular-nums ${scoreColorClass(latestScore)}`}
    >
      {latestScore.toFixed(1)}
    </span>
  );
}

export function MemberScoreCell({ orgId, userId }: MemberScoreCellProps) {
  return (
    <RequirePerm
      action={{ type: "report.read_org", orgId }}
      fallback={<span className="text-xs text-muted-foreground">—</span>}
    >
      <ScoreCellContent orgId={orgId} userId={userId} />
    </RequirePerm>
  );
}
