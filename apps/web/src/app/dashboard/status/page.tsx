"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { CredentialHealthSection } from "@/components/status/CredentialHealthSection";
import { ErrorRateSection } from "@/components/status/ErrorRateSection";
import { RecentActivitySection } from "@/components/status/RecentActivitySection";

export default function StatusPage() {
  const t = useTranslations("status");
  const utils = trpc.useUtils();

  const handleRefresh = () => {
    utils.accounts.listOwn.invalidate();
    utils.usage.errorSummary.invalidate();
    utils.usage.summary.invalidate();
    utils.usage.list.invalidate();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("pageTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageSubtitle")}</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4" />
          {t("refresh")}
        </Button>
      </div>
      <CredentialHealthSection />
      <ErrorRateSection />
      <RecentActivitySection />
    </div>
  );
}
