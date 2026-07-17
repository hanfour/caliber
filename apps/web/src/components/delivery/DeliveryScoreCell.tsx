"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { RequirePerm } from "@/components/RequirePerm";
import { scoreColorClass } from "@/components/evaluator/reportDetailShared";

interface DeliveryScoreCellProps {
  orgId: string;
  userId: string;
}

function DeliveryScoreCellContent({ orgId, userId }: DeliveryScoreCellProps) {
  const t = useTranslations("evaluator.report");
  // Memoize the range: a bare `new Date()` in render produces a new ISO string
  // every render → the tRPC query key changes every render → infinite refetch
  // loop (the score stays stuck at "…" and the API is hammered).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { rangeFrom: thirtyDaysAgo.toISOString(), rangeTo: now.toISOString() };
  }, []);

  const { data, isLoading, error } = trpc.githubDelivery.getReport.useQuery({
    orgId,
    userId,
    from: rangeFrom,
    to: rangeTo,
  });

  if (isLoading) {
    return <span className="text-xs text-muted-foreground">…</span>;
  }

  if (error || data == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const scoreNum = data.totalScore === null ? null : parseFloat(data.totalScore);
  const isInsufficientData = scoreNum === null || data.insufficientData;

  if (isInsufficientData) {
    return (
      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
        {t("insufficientData")}
      </span>
    );
  }

  return (
    <span
      className={`text-sm font-semibold tabular-nums ${scoreColorClass(scoreNum)}`}
    >
      {scoreNum!.toFixed(1)}
    </span>
  );
}

export function DeliveryScoreCell({ orgId, userId }: DeliveryScoreCellProps) {
  return (
    <RequirePerm
      action={{ type: "delivery.read_user", orgId, targetUserId: userId }}
      fallback={<span className="text-xs text-muted-foreground">—</span>}
    >
      <DeliveryScoreCellContent orgId={orgId} userId={userId} />
    </RequirePerm>
  );
}
