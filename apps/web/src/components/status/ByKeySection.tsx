"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageByKeyTable } from "@/components/usage/UsageByKeyTable";

/**
 * Member-facing per-API-key usage breakdown (own scope). 1 key ≈ 1 project,
 * so this lets a user track usage per project. Owner column hidden (all rows
 * are the caller's).
 */
export function ByKeySection() {
  const t = useTranslations("usage.byKey");
  const tCommon = useTranslations("common");
  const summary = trpc.usage.summary.useQuery({ scope: { type: "own" } });

  return (
    <Card className="shadow-card">
      <CardHeader className="space-y-0">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      </CardHeader>
      <CardContent>
        {summary.isLoading ? (
          <p className="text-sm text-muted-foreground">{tCommon("loading")}</p>
        ) : summary.error || !summary.data ? (
          <p className="text-xs text-destructive">{t("loadError")}</p>
        ) : (
          <UsageByKeyTable rows={summary.data.byKey} showOwner={false} />
        )}
      </CardContent>
    </Card>
  );
}
