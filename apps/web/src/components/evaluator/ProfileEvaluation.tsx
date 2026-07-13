"use client";

import { useMemo, useState } from "react";
import { Download, Trash2 } from "lucide-react";
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
import { ExportDialog } from "./ExportDialog";
import { DeleteRequestDialog } from "./DeleteRequestDialog";
import { FacetSummaryCard } from "./FacetSummaryCard";
import { DataProvenanceCard } from "./DataProvenanceCard";
import { ProjectScoreSection } from "./ProjectScoreSection";
import { LlmEvidenceList } from "./LlmEvidenceList";
import { GeneratedAudienceReport } from "./GeneratedAudienceReport";
import {
  EvaluationWindowSelect,
  selectionToRange,
  DEFAULT_SELECTION,
  type WindowSelection,
} from "./EvaluationWindowSelect";
import {
  scoreBadgeClass,
  SectionRow,
} from "./reportDetailShared";
import type { SectionResult } from "./reportDetailShared";
import type { ScorePoint } from "./TrendChart";
import type { RubricSignal } from "./rubricThreshold";

// ─── Main component ───────────────────────────────────────────────────────────

export function ProfileEvaluation() {
  const t = useTranslations("evaluator.profileEval");
  const tReport = useTranslations("evaluator.report");
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Memoize so the query key is stable across renders. Without this,
  // `new Date()` runs every render and tRPC keeps refetching, which keeps
  // `isLoading` pinned to true and never reveals the empty / loaded state.
  const [sel, setSel] = useState<WindowSelection>(DEFAULT_SELECTION);
  const { rangeFrom, rangeTo } = useMemo(() => {
    const { from, to } = selectionToRange(sel);
    return { rangeFrom: from, rangeTo: to };
  }, [sel]);

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

  const latestRubricId = latestReport?.rubricId ?? null;
  const { data: rubric } = trpc.rubrics.get.useQuery(
    { rubricId: latestRubricId ?? "" },
    { enabled: !!latestRubricId },
  );

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
  const hasGeneratedReport = latestReport.generatedReport != null;

  const rubricSectionsById: Record<string, { signals: RubricSignal[] }> = {};
  const rubricDef = rubric?.definition as
    | { sections?: Array<{ id: string; signals: RubricSignal[] }> }
    | undefined;
  for (const s of rubricDef?.sections ?? []) {
    rubricSectionsById[s.id] = { signals: s.signals };
  }
  const period =
    (latestReport.signalsSummary as
      | { period?: { requestCount?: number; bodyCount?: number } }
      | null)?.period ?? null;

  return (
    <div className="space-y-6">
      <ProfileBanner />

      {/* Latest score + trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("latestScore")}</CardTitle>
            <CardDescription>
              {t(sel.mode === "custom" ? "windowUpdatedCustom" : "windowUpdated", {
                days: sel.mode === "preset" ? sel.days : 0,
                date: new Date(latestReport.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>
          <div className="flex items-start gap-3">
            <EvaluationWindowSelect value={sel} onChange={setSel} />
            <span
              className={`rounded-full px-3 py-1 text-lg font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
            >
              {latestScore.toFixed(1)}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <TrendChart series={trendSeries} />
        </CardContent>
      </Card>

      <GeneratedAudienceReport
        audience={latestReport.reportAudience}
        report={latestReport.generatedReport}
        model={latestReport.llmModel}
        generatedAt={latestReport.llmCalledAt}
      />

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
      {!hasGeneratedReport && hasLlmNarrative && (
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

      <LlmEvidenceList evidence={latestReport.llmEvidence} />

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
                  <SectionRow
                    key={section.sectionId}
                    section={section}
                    rubricSection={rubricSectionsById[section.sectionId]}
                  />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <DataProvenanceCard
        sourceBreakdown={latestReport.sourceBreakdown as never}
        dataQuality={latestReport.dataQuality as never}
        period={period}
      />

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
