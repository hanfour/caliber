"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@caliber/api-types";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

type RubricRow = inferRouterOutputs<AppRouter>["rubrics"]["list"][number];
type DryRunResult = inferRouterOutputs<AppRouter>["rubrics"]["dryRun"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, max }: { score: number; max: number }) {
  const pct = Math.min(100, Math.round((score / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-2 rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-xs w-12 text-right text-muted-foreground">
        {score} / {max}
      </span>
    </div>
  );
}

// ─── Preview card ─────────────────────────────────────────────────────────────

interface PreviewCardProps {
  rubric: RubricRow;
  result: DryRunResult;
}

function PreviewCard({ rubric, result }: PreviewCardProps) {
  const { preview } = result;
  const t = useTranslations("evaluator.rubrics.dryRunPreview");
  const tReport = useTranslations("evaluator.report");

  return (
    <div className="space-y-4">
      {/* Usage-only warning */}
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <span className="font-semibold">{t("usageOnlyTitle")}</span> — {t("usageOnlyBody")}
      </div>

      {/* Period + rubric summary */}
      <div className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{rubric.name}</span> v{rubric.version}
        {" · "}
        {formatDate(result.periodStart)} – {formatDate(result.periodEnd)}
      </div>

      {/* Total score */}
      <div className="rounded-lg border border-border p-4 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">{t("totalScore")}</span>
          {preview.totalScore === null ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
              {tReport("insufficientData")}
            </span>
          ) : (
            <span className="text-2xl font-bold tabular-nums">{preview.totalScore}</span>
          )}
        </div>
        {preview.totalScore !== null && <ScoreBar score={preview.totalScore} max={120} />}
      </div>

      {/* Per-section breakdown */}
      {preview.sectionScores.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("sectionBreakdown")}
          </h3>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {preview.sectionScores.map((sec) => {
              const sectionMax = sec.maxScore ?? sec.superiorScore;
              return (
                <div key={sec.sectionId} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{sec.name}</span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{sec.weight}%</span>
                      {sec.score === null ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
                          {tReport("insufficientData")}
                        </span>
                      ) : (
                        <span className="font-semibold text-foreground tabular-nums">{sec.score}</span>
                      )}
                    </div>
                  </div>
                  {sec.score !== null && <ScoreBar score={sec.score} max={sectionMax} />}
                  <p className="text-xs text-muted-foreground">{sec.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Data quality */}
      <div className="text-xs text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1">
        <span>{t("totalRequests")}</span>
        <span className="tabular-nums">{preview.dataQuality.totalRequests}</span>
        <span>{t("capturedBodies")}</span>
        <span className="tabular-nums">{preview.dataQuality.capturedRequests}</span>
        <span>{t("coverage")}</span>
        <span className="tabular-nums">
          {Math.round(preview.dataQuality.coverageRatio * 100)}%
        </span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface DryRunPreviewProps {
  orgId: string;
  rubric: RubricRow;
  onClose: () => void;
}

export function DryRunPreview({ orgId, rubric, onClose }: DryRunPreviewProps) {
  const searchParams = useSearchParams();
  const t = useTranslations("evaluator.rubrics.dryRunPreview");
  const tCommon = useTranslations("common");
  // userId can be overridden via ?userId=<uuid> for admins previewing a specific member.
  // Falls back to the current user via the me.session call handled server-side.
  // We pass an empty string when no override, and the query stays disabled until
  // we have a valid userId.
  const userIdOverride = searchParams.get("userId");

  const { data: session } = trpc.me.session.useQuery();
  const currentUserId = session?.user?.id ?? null;
  const userId = userIdOverride ?? currentUserId;

  const { data, isLoading, error } = trpc.rubrics.dryRun.useQuery(
    { orgId, rubricId: rubric.id, userId: userId ?? "", days: 7 },
    { enabled: userId !== null && userId.length > 0, retry: 1 },
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {!userId && (
            <p className="text-sm text-muted-foreground">
              {t("waitingSession")}
            </p>
          )}

          {userId && isLoading && (
            <p className="text-sm text-muted-foreground">{t("running")}</p>
          )}

          {error && (
            <p className="text-sm text-destructive">
              {error.message || t("failedDefault")}
            </p>
          )}

          {data && <PreviewCard rubric={rubric} result={data} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
