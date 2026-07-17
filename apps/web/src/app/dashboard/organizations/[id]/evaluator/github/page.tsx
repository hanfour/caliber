"use client";

import { use } from "react";
import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { RequirePerm } from "@/components/RequirePerm";
import { GithubConnectionSettings } from "@/components/delivery/GithubConnectionSettings";
import { Card } from "@/components/ui/card";

export default function EvaluatorGithubPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const t = useTranslations("evaluator.githubConnection");
  const tCommon = useTranslations("common");

  return (
    <RequirePerm
      action={{ type: "github.manage", orgId }}
      fallback={
        <div className="container max-w-3xl py-8">
          <Card className="shadow-card flex flex-col items-center p-10 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              {tCommon("insufficientPermission")}
            </p>
          </Card>
        </div>
      }
    >
      <div className="container max-w-3xl py-8 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
        </header>
        <GithubConnectionSettings orgId={orgId} />
      </div>
    </RequirePerm>
  );
}
