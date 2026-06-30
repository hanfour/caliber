"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageByKeyTable } from "@/components/usage/UsageByKeyTable";

/**
 * Member-facing per-API-key usage breakdown (own scope). 1 key ≈ 1 project,
 * so this lets a user track usage per project. Owner column hidden (all rows
 * are the caller's).
 *
 * When the caller has keys opted into project scoring ("Score as project"),
 * surfaces a link to the per-project scores on the evaluation page.
 */
export function ByKeySection() {
  const t = useTranslations("usage.byKey");
  const tProjects = useTranslations("evaluator.projects");
  const tCommon = useTranslations("common");
  const summary = trpc.usage.summary.useQuery({ scope: { type: "own" } });
  const projectKeys = trpc.reports.listProjectKeys.useQuery({});

  const hasProjectKeys = !!projectKeys.data && projectKeys.data.length > 0;

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

        {hasProjectKeys && (
          <Link
            href="/dashboard/profile/evaluation"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {tProjects("viewScore")}
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
