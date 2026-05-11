"use client";

import { useEffect, useState } from "react";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import { formatUsd } from "@/lib/money";

type Scope = inferRouterInputs<AppRouter>["usage"]["list"]["scope"];
type UsageRow = inferRouterOutputs<AppRouter>["usage"]["list"]["items"][number];

// TODO: per-request detail modal with the full row + failed accounts payload.
// For now we surface a compact grid; the columns were chosen to cover what an
// operator needs to triage a request without jumping to the DB.

const PAGE_SIZE = 25;

interface Props {
  scope: Scope;
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

function Row({ row }: { row: UsageRow }) {
  const totalTokens = row.inputTokens + row.outputTokens;
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td
        className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground"
        title={new Date(row.createdAt).toLocaleString()}
      >
        {formatRelative(row.createdAt)}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{row.requestedModel}</td>
      <td className="px-3 py-2">
        <Badge
          variant="secondary"
          className="rounded-md font-mono text-[10px] font-normal"
        >
          {row.surface}
        </Badge>
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
        {formatUsd(row.totalCost)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {formatDuration(row.durationMs)}
      </td>
    </tr>
  );
}

export function UsageTable({ scope, from, to }: Props) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [from, to, scope]);

  const query = trpc.usage.list.useQuery({
    scope,
    from,
    to,
    page,
    pageSize: PAGE_SIZE,
  });

  if (query.error) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {query.error.message}
      </Card>
    );
  }

  const data = query.data;
  const totalPages = data
    ? Math.max(1, Math.ceil(data.totalCount / PAGE_SIZE))
    : 1;
  const items = data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {query.isLoading
            ? "Loading…"
            : `${data?.totalCount.toLocaleString() ?? 0} requests`}
        </span>
        <span>
          Page {data?.page ?? page} of {totalPages}
        </span>
      </div>

      <Card className="shadow-card overflow-hidden">
        {query.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No requests in this range.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Created
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Model
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Surface
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Tokens
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Cost
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page <= 1 || query.isLoading}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page >= totalPages || query.isLoading}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
