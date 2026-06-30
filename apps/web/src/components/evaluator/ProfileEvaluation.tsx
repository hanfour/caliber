"use client";

import { useMemo, useState } from "react";
import { Download, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProfileBanner } from "./ProfileBanner";
import { TrendChart } from "./TrendChart";
import { EvidenceRow } from "./EvidenceRow";
import { ExportDialog } from "./ExportDialog";
import { DeleteRequestDialog } from "./DeleteRequestDialog";
import { FacetSummaryCard } from "./FacetSummaryCard";
import { ProjectScoreSection } from "./ProjectScoreSection";
import type { ScorePoint } from "./TrendChart";
import type { SignalHitDisplay } from "./EvidenceRow";

// ─── Types (mirrors evaluator/engine/types.ts stored in jsonb) ────────────────

interface EvidenceItem {
  requestId?: string;
  quote: string;
  offset: number;
}

interface SignalHit {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
}

interface SectionResult {
  sectionId: string;
  name: string;
  weight: number;
  standardScore: number;
  superiorScore: number;
  score: number;
  label: string;
  signals: SignalHit[];
}

// ─── Score colour helpers ─────────────────────────────────────────────────────

function scoreColorClass(score: number): string {
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

function scoreBadgeClass(score: number): string {
  if (score >= 100)
    return "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800";
  if (score >= 80)
    return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800";
  return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800";
}

// ─── Section row with expand/collapse ────────────────────────────────────────

interface SectionRowProps {
  section: SectionResult;
}

function SectionRow({ section }: SectionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("evaluator.report");

  const signals: SignalHitDisplay[] = section.signals.map((s) => ({
    id: s.id,
    hit: s.hit,
    evidence: s.evidence,
  }));

  const isSuperior =
    section.score === section.superiorScore &&
    section.superiorScore > section.standardScore;

  return (
    <>
      <tr
        className="border-b border-border hover:bg-accent/20 cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium text-sm">{section.name}</span>
          </div>
          <div className="ml-5.5 mt-0.5 text-[10px] font-mono text-muted-foreground">
            {section.sectionId}
          </div>
        </td>
        <td className="px-4 py-2.5 text-center">
          <span
            className={`text-sm font-semibold tabular-nums ${scoreColorClass(section.score)}`}
          >
            {section.score}
          </span>
        </td>
        <td className="px-4 py-2.5 text-center text-xs text-muted-foreground tabular-nums">
          {section.weight}%
        </td>
        <td className="px-4 py-2.5 text-center">
          {isSuperior ? (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800">
              {t("superior")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {section.label}
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border bg-muted/20">
          <td colSpan={4} className="p-0">
            <EvidenceRow signals={signals} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ProfileEvaluation() {
  const t = useTranslations("evaluator.profileEval");
  const tReport = useTranslations("evaluator.report");
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Memoize so the query key is stable across renders. Without this,
  // `new Date()` runs every render and tRPC keeps refetching, which keeps
  // `isLoading` pinned to true and never reveals the empty / loaded state.
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      rangeFrom: thirtyDaysAgo.toISOString(),
      rangeTo: now.toISOString(),
    };
  }, []);

  const {
    data: latestReport,
    isLoading: latestLoading,
    error: latestError,
  } = trpc.reports.getOwnLatest.useQuery();

  const {
    data: rangeReports,
    isLoading: rangeLoading,
    error: rangeError,
  } = trpc.reports.getOwnRange.useQuery({ from: rangeFrom, to: rangeTo });

  const isLoading = latestLoading || rangeLoading;
  const error = latestError ?? rangeError;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <ProfileBanner />
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            {t("loading")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <ProfileBanner />
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            {error.message}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Empty state — no reports yet
  if (!latestReport || !rangeReports || rangeReports.length === 0) {
    return (
      <div className="space-y-6">
        <ProfileBanner />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("noEvaluationsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="py-4 text-sm text-muted-foreground">
            {t("noEvaluationsDesc")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const latestScore = parseFloat(latestReport.totalScore);

  // Build 30-day trend series: oldest → newest
  const trendSeries: ScorePoint[] = [...rangeReports].reverse().map((r) => ({
    date: new Date(r.periodStart).toISOString().slice(0, 10),
    score: parseFloat(r.totalScore),
  }));

  // Parse section scores from jsonb (SectionResult[])
  const sectionScores: SectionResult[] = Array.isArray(
    latestReport.sectionScores,
  )
    ? (latestReport.sectionScores as SectionResult[])
    : [];

  const hasLlmNarrative =
    typeof latestReport.llmNarrative === "string" &&
    latestReport.llmNarrative.length > 0;

  return (
    <div className="space-y-6">
      <ProfileBanner />

      {/* Latest score + trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("latestScore")}</CardTitle>
            <CardDescription>
              {t("thirtyDayWindowEnding", {
                date: new Date(latestReport.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-lg font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
          >
            {latestScore.toFixed(1)}
          </span>
        </CardHeader>
        <CardContent>
          <TrendChart series={trendSeries} />
        </CardContent>
      </Card>

      {/* Facet drill-down (Plan 4C follow-up #3). Hidden silently when
          there are no facet rows for this period. */}
      <FacetSummaryCard
        orgId={latestReport.orgId}
        userId={latestReport.userId}
        rangeFrom={
          typeof latestReport.periodStart === "string"
            ? latestReport.periodStart
            : new Date(latestReport.periodStart).toISOString()
        }
        rangeTo={
          typeof latestReport.periodEnd === "string"
            ? latestReport.periodEnd
            : new Date(latestReport.periodEnd).toISOString()
        }
      />

      {/* LLM narrative — owner always has full visibility */}
      {hasLlmNarrative && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {tReport("aiNarrative")}
            </CardTitle>
            <CardDescription className="text-xs">
              {latestReport.llmCalledAt
                ? tReport("generatedByDate", {
                    model: latestReport.llmModel ?? "LLM",
                    date: new Date(latestReport.llmCalledAt).toLocaleDateString(),
                  })
                : tReport("generatedBy", { model: latestReport.llmModel ?? "LLM" })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {latestReport.llmNarrative}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Section scores table */}
      {sectionScores.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {tReport("sectionScores")}
            </CardTitle>
            <CardDescription className="text-xs">
              {tReport("clickToExpand")}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">{tReport("section")}</th>
                  <th className="px-4 py-2 text-center font-medium">{tReport("score")}</th>
                  <th className="px-4 py-2 text-center font-medium">{tReport("weight")}</th>
                  <th className="px-4 py-2 text-center font-medium">{tReport("label")}</th>
                </tr>
              </thead>
              <tbody>
                {sectionScores.map((section) => (
                  <SectionRow key={section.sectionId} section={section} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Per-project (per-key) scores for keys opted into project evaluation */}
      <ProjectScoreSection />

      {/* Export + Delete buttons */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => setExportOpen(true)}
        >
          <Download className="h-4 w-4" />
          {t("exportMyData")}
        </Button>
        <Button
          variant="outline"
          className="gap-2 text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          {t("requestDeletion")}
        </Button>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      {latestReport && (
        <DeleteRequestDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          orgId={latestReport.orgId}
        />
      )}
    </div>
  );
}
