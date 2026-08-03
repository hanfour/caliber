"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import { formatUsd } from "@/lib/money";
import { getReplayGate } from "./replayGate";
import { ReplayDialog } from "./ReplayDialog";

type RequestRow =
  inferRouterOutputs<AppRouter>["usage"]["listRequests"]["rows"][number];

// NOTE on the "stale running replay" hazard (single-request-replay design
// doc, carried into both Task 10 and Task 11): a `running` replay_runs row
// is a one-way claim (queued → running) with no sweeper, so a worker crash
// mid-run strands it there forever with nothing to flip it to failed. This
// page intentionally has NO surface area for that hazard — it only lists
// `usage_logs` (see usage.ts's listRequests doc comment) and never reads
// `replay_runs`, so there is no row-level run status rendered here at all.
// Task 11's comparison page is the one that reads replay_runs directly, and
// IT must treat a sufficiently old `running` row as failed wherever it
// renders that status.

interface Props {
  orgId: string;
  orgIdentifier: string;
  userId: string;
  from: string;
  to: string;
}

function statusTone(statusCode: number): string {
  if (statusCode >= 500)
    return "border-transparent bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300";
  if (statusCode >= 400)
    return "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300";
  if (statusCode >= 200)
    return "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300";
  return "border-transparent bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300";
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function ReplayCell({
  row,
  replayEnabled,
  onOpen,
}: {
  row: RequestRow;
  replayEnabled: boolean;
  onOpen: (row: RequestRow) => void;
}) {
  const t = useTranslations("requests");
  const gate = getReplayGate(row, replayEnabled);

  if (gate.disabled && gate.reason === "replayDisabled") {
    // The page-level banner (rendered once, above the table) already
    // explains this — repeating the same sentence on every row would be
    // noise, not clarity.
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const reasonText =
    gate.disabled && gate.reason === "truncated"
      ? t("disabledTruncated")
      : gate.disabled && gate.reason === "noBody"
        ? t("disabledNoBody")
        : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={gate.disabled}
        onClick={() => onOpen(row)}
      >
        {t("replayButton")}
      </Button>
      {reasonText && (
        <span className="max-w-[16rem] text-right text-[11px] leading-tight text-muted-foreground">
          {reasonText}
        </span>
      )}
    </div>
  );
}

function Row({
  row,
  replayEnabled,
  onOpenReplay,
}: {
  row: RequestRow;
  replayEnabled: boolean;
  onOpenReplay: (row: RequestRow) => void;
}) {
  const t = useTranslations("requests");
  const totalTokens = row.inputTokens + row.outputTokens;
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td
        className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground"
        title={new Date(row.createdAt).toLocaleString()}
      >
        {formatRelative(row.createdAt)}
      </td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs">{row.requestedModel}</div>
        {row.upstreamModel && row.upstreamModel !== row.requestedModel && (
          <div className="font-mono text-[10px] text-muted-foreground">
            {row.upstreamModel}
          </div>
        )}
        {row.replayOfRequestId && (
          <Badge
            variant="secondary"
            className="mt-1 rounded-md text-[10px] font-normal"
          >
            {t("replayBadge")}
          </Badge>
        )}
      </td>
      <td className="px-3 py-2">
        <Badge
          variant="outline"
          className={cn(
            "font-mono text-[10px] font-medium",
            statusTone(row.statusCode),
          )}
        >
          {row.statusCode}
        </Badge>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
        {totalTokens.toLocaleString()}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
        {formatUsd(row.costUsd)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {formatDuration(row.durationMs)}
      </td>
      <td className="px-3 py-2 text-right">
        <ReplayCell
          row={row}
          replayEnabled={replayEnabled}
          onOpen={onOpenReplay}
        />
      </td>
    </tr>
  );
}

export function RequestsTable({ orgId, orgIdentifier, userId, from, to }: Props) {
  const t = useTranslations("requests");
  const [replayTarget, setReplayTarget] = useState<RequestRow | null>(null);

  const query = trpc.usage.listRequests.useInfiniteQuery(
    { orgId, userId, from, to },
    {
      enabled: !!orgId && !!userId,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    },
  );

  if (query.error) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {t("loadError")}
      </Card>
    );
  }

  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  // A missing field on any page would fall back to enabled=true — the wrong
  // direction for a UX-only signal. First page decides for the whole list;
  // the flag is a deployment-level constant (ENABLE_EVALUATOR), never
  // per-row, so it cannot disagree across pages.
  const replayEnabled = pages[0]?.replayEnabled ?? false;

  return (
    <div className="space-y-3">
      {rows.length > 0 && !replayEnabled && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {t("replayNotEnabledBanner")}
        </div>
      )}

      <Card className="shadow-card overflow-hidden">
        {query.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colTime")}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colModel")}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colStatus")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("colTokens")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("colCost")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("colDuration")}
                </th>
                {/* Always rendered, even when replayEnabled is false — the
                    per-row cell (ReplayCell) always renders a trailing "—"
                    or a button, so the header must match 1:1 or the table
                    misaligns by one column. */}
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("colReplay")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row
                  key={row.requestId}
                  row={row}
                  replayEnabled={replayEnabled}
                  onOpenReplay={setReplayTarget}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}

      {replayTarget && (
        <ReplayDialog
          open={!!replayTarget}
          onOpenChange={(open) => {
            if (!open) setReplayTarget(null);
          }}
          orgId={orgId}
          orgIdentifier={orgIdentifier}
          requestId={replayTarget.requestId}
          sourceModel={replayTarget.requestedModel}
        />
      )}
    </div>
  );
}
