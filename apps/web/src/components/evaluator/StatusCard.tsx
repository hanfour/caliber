"use client";

import { useState } from "react";
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

interface Props {
  orgId: string;
}

export function StatusCard({ orgId }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const t = useTranslations("evaluator.status");

  const {
    data: status,
    isLoading,
    refetch,
  } = trpc.evaluator.status.useQuery({ orgId });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refetch();
      toast.success(t("refreshedToast"));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("refreshFailed");
      toast.error(message);
    } finally {
      setIsRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("cronHealthTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("loadingStatus")}</p>
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("cronHealthTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("noData")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const formatDate = (date: Date | string | null) => {
    if (!date) return t("never");
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  };

  const periodStart = status.lastPeriodStart
    ? new Date(status.lastPeriodStart).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>{t("cronHealthTitle")}</CardTitle>
          <CardDescription>
            {t("cronHealthDesc")}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? t("refreshing") : t("refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Last cron run */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              {t("lastCronRun")}
            </p>
            <p className="text-sm font-mono">{formatDate(status.lastCronAt)}</p>
            {status.lastPeriodStart && (
              <p className="text-xs text-muted-foreground">
                {t("periodFrom", { date: periodStart })}
              </p>
            )}
          </div>

          {/* Next cron scheduled */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              {t("nextCronScheduled")}
            </p>
            <p className="text-sm font-mono">{formatDate(status.nextCronAt)}</p>
            <p className="text-xs text-muted-foreground">{t("cronDailyAt", { time: "00:05" })}</p>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-border" />

        {/* Member count and reports */}
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              {t("members")}
            </p>
            <p className="text-2xl font-semibold">{status.memberCount}</p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              {t("reports24h")}
            </p>
            <p className="text-2xl font-semibold">
              {status.reportsWrittenLast24h}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              {t("coverage")}
            </p>
            <p className="text-2xl font-semibold">
              {status.coveragePct.toFixed(1)}%
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
