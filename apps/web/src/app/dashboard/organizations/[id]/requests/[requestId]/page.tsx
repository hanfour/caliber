"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { formatRelative } from "@/lib/time";
import { ReplayComparisonView } from "@/components/requests/ReplayComparisonView";

// Native select mirroring the shadcn `Input` primitive — same class string the
// requests list page uses (no <Select> component in this design system yet).
const SELECT_CLASS =
  "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One captured request's replay comparison.
 *
 * The route is keyed by requestId (that is what the list page and the replay
 * dialog know), while a comparison is per RUN — so this page lists the
 * request's runs and shows one. Newest first, defaulting to the newest, which
 * is the one the operator just started.
 */
export default function ReplayComparisonPage() {
  const params = useParams();
  const identifier = params?.id as string;
  const requestId = params?.requestId as string;
  const t = useTranslations("replayComparison");

  const { data: org } = trpc.organizations.resolveIdentifier.useQuery(
    { identifier },
    { enabled: !!identifier },
  );
  const orgId = org?.id;

  const runsQuery = trpc.replay.listForRequest.useQuery(
    { orgId: orgId!, requestId },
    { enabled: !!orgId && !!requestId },
  );
  const runs = runsQuery.data;

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Reset whenever the route changes: the App Router reuses this component
  // instance across /requests/<A> → /requests/<B>, and a stale run id from the
  // previous request would resolve to NOT_FOUND (or, worse, silently show
  // another request's comparison).
  useEffect(() => {
    setSelectedRunId(null);
  }, [orgId, requestId]);

  const effectiveRunId =
    selectedRunId && runs?.some((r) => r.id === selectedRunId)
      ? selectedRunId
      : (runs?.[0]?.id ?? null);

  const backHref = `/dashboard/organizations/${identifier}/requests`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {requestId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {runs && runs.length > 1 && (
            <select
              aria-label={t("runSelectLabel")}
              className={SELECT_CLASS}
              value={effectiveRunId ?? ""}
              onChange={(e) => setSelectedRunId(e.target.value)}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {`${run.targetModel} · ${formatRelative(run.createdAt)}`}
                </option>
              ))}
            </select>
          )}
          <Link
            href={backHref}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t("backToList")}
          </Link>
        </div>
      </div>

      {!orgId || runsQuery.isLoading ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {t("loading")}
        </Card>
      ) : runsQuery.error ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {(runsQuery.error.data as { code?: string } | undefined)?.code ===
          "FORBIDDEN"
            ? t("noPermission")
            : t("loadError")}
        </Card>
      ) : !effectiveRunId ? (
        <Card className="shadow-card p-6 text-sm text-muted-foreground">
          {t("noRuns")}
        </Card>
      ) : (
        <ReplayComparisonView
          orgId={orgId}
          requestId={requestId}
          runId={effectiveRunId}
          onRunCreated={setSelectedRunId}
        />
      )}
    </div>
  );
}
