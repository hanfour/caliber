"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { KeyRound, ShieldAlert, Users } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { RequirePerm } from "@/components/RequirePerm";
import { MemberScoreCell } from "@/components/evaluator";

export default function MembersTab() {
  const params = useParams();
  const identifier = params?.id as string;
  // The URL segment can be the org slug (e.g. "onead") OR its UUID; resolve it
  // to the canonical UUID before any query whose input is z.string().uuid(),
  // otherwise a slug 400s ("UUID 格式不正確").
  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;
  const {
    data: members,
    isLoading,
    error,
  } = trpc.users.list.useQuery(
    { orgId: orgId! },
    { enabled: !!orgId },
  );
  const t = useTranslations("members");
  const tPage = useTranslations("membersPage");
  const tCommon = useTranslations("common");

  if (!orgId || isLoading) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {tCommon("loading")}
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <ShieldAlert className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">{tPage("unableToLoad")}</h3>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {error.message}
        </p>
      </Card>
    );
  }

  if (!members || members.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center p-10 text-center">
        <Users className="h-6 w-6 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-semibold">{tPage("emptyTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {tPage("emptyHint")}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {members.length === 1
          ? t("countSingular")
          : t("countPlural", { count: members.length })}
      </p>
      <Card className="shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">{t("name")}</th>
              <th className="px-4 py-2 text-left font-medium">{t("joined")}</th>
              <th className="px-4 py-2 text-center font-medium">
                {t("latestScore")}
              </th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr
                key={m.id}
                className="border-b border-border last:border-0 hover:bg-accent/20"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {m.email.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <Link
                        href={`/dashboard/organizations/${identifier}/members/${m.id}`}
                        className="font-medium hover:underline"
                      >
                        {m.name ?? m.email}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {m.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <MemberScoreCell orgId={orgId} userId={m.id} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <RequirePerm
                    action={{
                      type: "api_key.issue_for_user",
                      orgId,
                      targetUserId: m.id,
                    }}
                  >
                    <Link
                      href={`/dashboard/organizations/${identifier}/members/${m.id}/api-keys`}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {t("apiKeys")}
                    </Link>
                  </RequirePerm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
