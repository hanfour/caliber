"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";
import { FidelityBanner } from "./FidelityBanner";
import { ResponsePanel } from "./ResponsePanel";
import { bodyToText, lineDiff, type DiffLine } from "./lineDiff";
import {
  describeFailureReason,
  STALE_RUNNING_REASON,
} from "./replayFailureReason";

type Comparison = inferRouterOutputs<AppRouter>["replay"]["getComparison"];
type Side = Comparison["source"];

const POLL_MS = 3000;

interface Props {
  orgId: string;
  requestId: string;
  runId: string;
  /** Called with the new run's id after a same-model baseline is started. */
  onRunCreated: (runId: string) => void;
}

/**
 * A `running` run the API has stopped calling healthy — but which may still
 * finish. See `STALE_RUNNING_REASON`: the API's window includes queue time, so
 * this fires on backlogged-but-alive runs too.
 */
function isStaleButWatched(data: Comparison | undefined): boolean {
  return (
    data?.status === "failed" && data.failureReason === STALE_RUNNING_REASON
  );
}

/**
 * Is this run still expected to change on its own?
 *
 * Three things are true here and each one is load-bearing:
 *
 *  1. `ok` with a null replay is pending: the gateway marks a run `ok` the
 *     moment its loopback returns, but the replay's own `usage_logs` row is
 *     written by a separate asynchronous pipeline. That gap is "results being
 *     written", not "no result". The API bounds it — past its window the
 *     status becomes `failed`/`result_missing`, so this branch cannot spin
 *     forever.
 *  2. A stale `running` run is ALSO pending. It is reported as failed so the
 *     reader is warned, but the run may simply be queued behind others; if
 *     polling stopped here, a run that came back a minute later would never
 *     replace the warning and the operator would spend another billed replay
 *     on a run that was fine.
 *  3. Every other `failed` is terminal — including `result_missing`, where the
 *     usage row is genuinely gone and no amount of waiting will produce it.
 */
function isPending(data: Comparison | undefined): boolean {
  if (!data) return false;
  if (data.status === "queued" || data.status === "running") return true;
  if (isStaleButWatched(data)) return true;
  return data.status === "ok" && data.replay === null;
}

function MetricRow({
  label,
  source,
  replay,
}: {
  label: string;
  source: string;
  replay: string;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <th
        scope="row"
        className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
      >
        {label}
      </th>
      <td className="px-3 py-2 font-mono text-xs tabular-nums">{source}</td>
      <td className="px-3 py-2 font-mono text-xs tabular-nums">{replay}</td>
    </tr>
  );
}

export function ReplayComparisonView({
  orgId,
  requestId,
  runId,
  onRunCreated,
}: Props) {
  const t = useTranslations("replayComparison");
  const tCommon = useTranslations("common");
  const utils = trpc.useUtils();

  const query = trpc.replay.getComparison.useQuery(
    { orgId, runId },
    {
      refetchInterval: (q) => (isPending(q.state.data) ? POLL_MS : false),
    },
  );

  const enqueue = trpc.replay.enqueue.useMutation({
    onSuccess: (res) => {
      toast.success(t("baselineStarted"));
      void utils.replay.listForRequest.invalidate({ orgId, requestId });
      onRunCreated(res.runId);
    },
    onError: (e) => {
      const code = (e.data as { code?: string } | undefined)?.code;
      toast.error(
        code === "FORBIDDEN"
          ? tCommon("insufficientPermission")
          : e.message || tCommon("error"),
      );
    },
  });

  const data = query.data;

  // Both sides are aligned in one pass so the highlighted lines on the left
  // and the right come from the SAME alignment — computing them separately
  // would let the two panels disagree about what changed.
  const diff = useMemo(() => {
    const leftText = bodyToText(data?.source.responseBody ?? null);
    const rightText = bodyToText(data?.replay?.responseBody ?? null);

    // Align only when both sides exist — with one side missing there is
    // nothing to diff against, and marking every line of the survivor as
    // "changed" would invent a difference the reader cannot verify.
    if (leftText !== null && rightText !== null) {
      const d = lineDiff(leftText, rightText);
      return { left: d.left, right: d.right, computed: d.computed };
    }

    const plain = (s: string | null): DiffLine[] | null =>
      s === null
        ? null
        : s.split("\n").map((text) => ({ op: "same" as const, text }));
    return { left: plain(leftText), right: plain(rightText), computed: true };
  }, [data]);

  if (query.isLoading) {
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {t("loading")}
      </Card>
    );
  }

  if (query.error || !data) {
    const code = (query.error?.data as { code?: string } | undefined)?.code;
    const message =
      code === "FORBIDDEN"
        ? t("noPermission")
        : code === "PRECONDITION_FAILED"
          ? t("keyNotConfigured")
          : t("loadError");
    return (
      <Card className="shadow-card p-6 text-sm text-muted-foreground">
        {message}
      </Card>
    );
  }

  const failure = describeFailureReason(
    data.status === "failed" ? data.failureReason : null,
  );
  const staleButWatched = isStaleButWatched(data);
  const notComparable = t("notComparable");
  // A stale-but-watched run has NOT finished — the page is still polling it —
  // so its empty metric cells must read "no result yet", not "did not finish".
  const pendingReplayCell =
    data.status === "failed" && !staleButWatched
      ? t("replayFailedShort")
      : t("replayPendingShort");

  const cell = (side: Side | null, read: (s: Side) => string): string =>
    side ? read(side) : pendingReplayCell;

  return (
    <div className="space-y-4">
      {/* ── The caveats come FIRST. See FidelityBanner's own comment. ── */}
      <FidelityBanner
        fidelity={data.fidelity}
        comparableCost={data.comparable.cost}
        sourceCacheReadTokens={data.source.cacheReadTokens}
        replayCacheReadTokens={data.replay?.cacheReadTokens ?? null}
      />

      {/* Rendered on `failed` even when the row carries no reason: "this did
          not finish" is the fact the reader needs, and withholding it because
          the explanation is missing would leave the page looking like a run
          that is merely quiet.

          A stale-but-watched run takes the amber "still waiting" treatment
          instead of the rose failure one: the page is still polling, so
          dressing it as a completed failure would push the operator into
          spending a second billed replay on a run that has not finished. */}
      {data.status === "failed" && (
        <Card
          role="status"
          className={cn(
            "shadow-card p-4 text-sm",
            staleButWatched
              ? "border-amber-300 dark:border-amber-500/40"
              : "border-rose-300 dark:border-rose-500/40",
          )}
        >
          <p className="font-medium">
            {staleButWatched ? t("statusStalledTitle") : t("statusFailedTitle")}
          </p>
          {failure && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`reason.${failure.key}`, failure.values)}
            </p>
          )}
        </Card>
      )}

      {isPending(data) && !staleButWatched && (
        <Card
          role="status"
          className="shadow-card p-4 text-sm text-muted-foreground"
        >
          {data.status === "queued"
            ? t("statusQueued")
            : data.status === "running"
              ? t("statusRunning")
              : t("statusMaterializing")}
        </Card>
      )}

      <div data-testid="comparison-content" className="space-y-4">
        <Card className="shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colMetric")}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colSource")}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t("colReplay")}
                </th>
              </tr>
            </thead>
            <tbody>
              <MetricRow
                label={t("metricModel")}
                source={data.source.model}
                replay={cell(data.replay, (s) => s.model)}
              />
              <MetricRow
                label={t("metricUpstreamModel")}
                source={data.source.upstreamModel}
                replay={cell(data.replay, (s) => s.upstreamModel)}
              />
              <MetricRow
                label={t("metricInputTokens")}
                source={data.source.inputTokens.toLocaleString()}
                replay={cell(data.replay, (s) =>
                  s.inputTokens.toLocaleString(),
                )}
              />
              <MetricRow
                label={t("metricOutputTokens")}
                source={data.source.outputTokens.toLocaleString()}
                replay={cell(data.replay, (s) =>
                  s.outputTokens.toLocaleString(),
                )}
              />
              <MetricRow
                label={t("metricCacheReadTokens")}
                source={data.source.cacheReadTokens.toLocaleString()}
                replay={cell(data.replay, (s) =>
                  s.cacheReadTokens.toLocaleString(),
                )}
              />
              {/* Cost and latency are rendered as words, not numbers, whenever
                  the two sides are not priced/measured the same way. A number
                  the reader can subtract IS a claim that subtracting it means
                  something. */}
              <MetricRow
                label={t("metricCost")}
                source={
                  data.comparable.cost
                    ? formatUsd(data.source.totalCost, 4)
                    : notComparable
                }
                replay={
                  data.comparable.cost
                    ? cell(data.replay, (s) => formatUsd(s.totalCost, 4))
                    : notComparable
                }
              />
              <MetricRow
                label={t("metricLatency")}
                source={notComparable}
                replay={notComparable}
              />
            </tbody>
          </table>
        </Card>

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>{t("latencyNote")}</p>
          {!data.comparable.cost && <p>{t("costNote")}</p>}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <ResponsePanel
            testId="source-response"
            title={t("sourceResponseTitle")}
            lines={diff.left}
            emptyText={t("responseUnavailable")}
            diffSkipped={!diff.computed}
          />
          <ResponsePanel
            testId="replay-response"
            title={t("replayResponseTitle")}
            lines={diff.right}
            emptyText={
              data.replay === null ? t("replayPending") : t("responseUnavailable")
            }
            diffSkipped={!diff.computed}
          />
        </div>
      </div>

      {/* ── Noise baseline. Not optional: without a same-model rerun the
             reader cannot tell a model-change difference from ordinary
             sampling variance. There is deliberately no "retry this run"
             affordance — a run's claim is one-way, so re-running always
             means a brand new run. ── */}
      <Card className="shadow-card flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t("baselineHint")}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={enqueue.isPending}
          onClick={() =>
            enqueue.mutate({
              orgId,
              requestId,
              targetModel: data.source.model,
            })
          }
        >
          {enqueue.isPending ? t("baselineSubmitting") : t("baselineButton")}
        </Button>
      </Card>
    </div>
  );
}
