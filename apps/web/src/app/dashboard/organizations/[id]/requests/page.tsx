"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { RequirePerm } from "@/components/RequirePerm";
import { usePermissions } from "@/lib/usePermissions";
import {
  TimeRangePicker,
  rangeToDates,
  type RangePreset,
} from "@/components/usage/TimeRangePicker";
import { RequestsTable } from "@/components/requests/RequestsTable";

// Native select mirroring the shadcn `Input` primitive — matches
// AdminIssueDialog's SELECT_CLASS (no <Select> component in this design
// system yet).
const SELECT_CLASS =
  "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export default function OrgRequestsPage() {
  const params = useParams();
  const identifier = params?.id as string;
  const [range, setRange] = useState<RangePreset>("30d");
  const { from, to } = useMemo(() => rangeToDates(range), [range]);
  const t = useTranslations("requests");
  const { perm } = usePermissions();

  // The URL segment can be the org slug or UUID; resolve to the canonical
  // UUID before any query whose input is z.string().uuid() (matches
  // sessions/page.tsx and every other org sub-page).
  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;

  // usage.listRequests takes an explicit userId (Task 9: "an operator
  // browses ONE member's captured requests") — there is no org-wide variant.
  // Default to the signed-in caller's own id (always permitted per
  // usage.read_user's self-branch); a member picker lets an org_admin
  // investigate someone else's requests, which is the whole point of the
  // "operator" framing.
  const { data: members } = trpc.users.list.useQuery(
    { orgId: orgId! },
    { enabled: !!orgId },
  );
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  // Next.js's App Router reuses this page's component instance across
  // /organizations/<A>/requests -> /organizations/<B>/requests navigations
  // (same route pattern, different [id]) — without this reset, an admin
  // switching orgs would keep the PREVIOUS org's selected member, which is
  // at best a confusing "no permission" dead end and at worst silently
  // shows the wrong org's member if the same user id happens to exist in
  // both.
  useEffect(() => {
    setSelectedUserId(null);
  }, [orgId]);
  const effectiveUserId = selectedUserId ?? perm?.userId ?? null;

  if (!orgId || !effectiveUserId) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {t("loading")}
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {members && members.length > 1 && (
            <select
              aria-label={t("memberSelectLabel")}
              className={SELECT_CLASS}
              value={effectiveUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </option>
              ))}
            </select>
          )}
          <TimeRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      <RequirePerm
        action={{
          type: "usage.read_user",
          orgId,
          targetUserId: effectiveUserId,
        }}
        fallback={
          <Card className="shadow-card p-6 text-sm text-muted-foreground">
            {t("noPermission")}
          </Card>
        }
      >
        <RequestsTable
          orgId={orgId}
          orgIdentifier={identifier}
          userId={effectiveUserId}
          from={from}
          to={to}
        />
      </RequirePerm>
    </div>
  );
}
