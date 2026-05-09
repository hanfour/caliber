"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

export function ProfileBanner() {
  const t = useTranslations("evaluator.profileEval");
  const { data: disclosure, isLoading } = trpc.me.captureDisclosure.useQuery();

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground animate-pulse">
        {t("loadingDisclosure")}
      </div>
    );
  }

  const enabledOrgs = disclosure ?? [];

  if (enabledOrgs.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">
            {t("captureNotEnabledTitle")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("captureNotEnabledHint")}
          </p>
        </div>
      </div>
    );
  }

  const primaryOrg = enabledOrgs[0];
  const retentionDays = primaryOrg?.retentionDays ?? 90;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900/50 dark:bg-blue-950/20">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
      <div className="space-y-1.5 text-sm">
        <p className="font-medium text-blue-900 dark:text-blue-100">
          {t("captureEnabledTitle")}
        </p>
        <p className="text-blue-800/80 dark:text-blue-200/80 text-xs leading-relaxed">
          {t("captureEnabledBodyDays", { days: retentionDays })}
        </p>
        <p className="text-blue-700/70 dark:text-blue-300/70 text-xs">
          {t("captureEnabledFooter")}
        </p>
      </div>
    </div>
  );
}
