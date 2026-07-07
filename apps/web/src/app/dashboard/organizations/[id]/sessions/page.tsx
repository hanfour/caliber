"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import {
  TimeRangePicker,
  rangeToDates,
  type RangePreset,
} from "@/components/usage/TimeRangePicker";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function OrgSessionsPage() {
  const params = useParams();
  const identifier = params?.id as string;
  const [range, setRange] = useState<RangePreset>("30d");
  const { from, to } = useMemo(() => rangeToDates(range), [range]);
  const t = useTranslations("sessions");

  // The URL segment can be the org slug or UUID; resolve to the canonical UUID
  // before the sessions query (its input is z.string().uuid()).
  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;

  const summary = trpc.sessions.orgSummary.useQuery(
    { orgId: orgId!, from, to },
    { enabled: !!orgId },
  );

  if (!orgId) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {t("loading")}
      </Card>
    );
  }

  return (
    <RequirePerm
      action={{ type: "usage.read_org", orgId }}
      fallback={
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {t("noPermission")}
        </Card>
      }
    >
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">{t("title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <TimeRangePicker value={range} onChange={setRange} />
        </div>

        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="text-base">{t("perMember")}</CardTitle>
          </CardHeader>
          <CardContent>
            {summary.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : summary.error ? (
              <p className="text-sm text-destructive">{t("loadError")}</p>
            ) : !summary.data || summary.data.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">{t("colMember")}</th>
                      <th className="py-2 pr-4 font-medium">{t("colSessions")}</th>
                      <th className="py-2 pr-4 font-medium">{t("colEvents")}</th>
                      <th className="py-2 pr-4 font-medium">{t("colSources")}</th>
                      <th className="py-2 pr-4 font-medium">{t("colFirst")}</th>
                      <th className="py-2 font-medium">{t("colLast")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.members.map((m) => (
                      <tr key={m.userId} className="border-b last:border-0">
                        <td className="py-2 pr-4">
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {m.name ?? m.email}
                            </div>
                            {m.name && (
                              <div className="truncate text-xs text-muted-foreground">
                                {m.email}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{m.sessionCount}</td>
                        <td className="py-2 pr-4 tabular-nums">{m.eventCount}</td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {m.sources["claude-code"] > 0 &&
                            `claude-code ${m.sources["claude-code"]}`}
                          {m.sources["claude-code"] > 0 && m.sources.codex > 0 && " · "}
                          {m.sources.codex > 0 && `codex ${m.sources.codex}`}
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {fmtDate(m.firstActivity)}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {fmtDate(m.lastActivity)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </RequirePerm>
  );
}
