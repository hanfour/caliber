"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TrendChart } from "./TrendChart";
import { EvidenceRow } from "./EvidenceRow";
import type { ScorePoint } from "./TrendChart";
import type { SignalHitDisplay } from "./EvidenceRow";

// ─── Types (mirrors evaluator/engine/types.ts shape stored in jsonb) ──────────

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

// ─── Score colour helpers (same thresholds as ProfileEvaluation/ReportDetail) ─

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

// ─── Section row with expand/collapse (same structure as ReportDetail) ────────

function SectionRow({ section }: { section: SectionResult }) {
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
            <span className="text-xs text-muted-foreground">{section.label}</span>
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

// ─── Per-key report renderer ──────────────────────────────────────────────────
// Fetches the by-key endpoints and renders the SAME visual structure as the
// per-person report (score badge + TrendChart + narrative + section table),
// rather than introducing a new visual design.

function ProjectKeyReport({ apiKeyId }: { apiKeyId: string }) {
  const t = useTranslations("evaluator.projects");
  const tReport = useTranslations("evaluator.report");

  // Memoise the 30-day window so the query key is stable across renders.
  // Without this `new Date()` runs every render → tRPC refetches forever and
  // `isLoading` stays pinned to true (same fix as ProfileEvaluation).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      rangeFrom: thirtyDaysAgo.toISOString(),
      rangeTo: now.toISOString(),
    };
  }, []);

  const { data: latest, isLoading: latestLoading } =
    trpc.reports.getOwnByKeyLatest.useQuery({ apiKeyId });
  const { data: range, isLoading: rangeLoading } =
    trpc.reports.getOwnByKeyRange.useQuery({
      apiKeyId,
      from: rangeFrom,
      to: rangeTo,
    });

  if (latestLoading || rangeLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {tReport("loading")}
        </CardContent>
      </Card>
    );
  }

  if (!latest) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {t("noReport")}
        </CardContent>
      </Card>
    );
  }

  const latestScore = parseFloat(latest.totalScore);

  // Build 30-day trend series: oldest → newest (immutable copy before reverse).
  const trendSeries: ScorePoint[] = [...(range ?? [])].reverse().map((r) => ({
    date: new Date(r.periodStart).toISOString().slice(0, 10),
    score: parseFloat(r.totalScore),
  }));

  const sectionScores: SectionResult[] = Array.isArray(latest.sectionScores)
    ? (latest.sectionScores as SectionResult[])
    : [];

  const hasLlmNarrative =
    typeof latest.llmNarrative === "string" && latest.llmNarrative.length > 0;

  return (
    <div className="space-y-4">
      {/* Latest score + trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>
              {tReport("thirtyDayWindow", {
                date: new Date(latest.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
          >
            {latestScore.toFixed(1)}
          </span>
        </CardHeader>
        <CardContent>
          <TrendChart series={trendSeries} />
        </CardContent>
      </Card>

      {/* LLM narrative — owner always has full visibility */}
      {hasLlmNarrative && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {tReport("aiNarrative")}
            </CardTitle>
            <CardDescription className="text-xs">
              {latest.llmCalledAt
                ? tReport("generatedByDate", {
                    model: latest.llmModel ?? "LLM",
                    date: new Date(latest.llmCalledAt).toLocaleDateString(),
                  })
                : tReport("generatedBy", { model: latest.llmModel ?? "LLM" })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {latest.llmNarrative}
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
                  <th className="px-4 py-2 text-left font-medium">
                    {tReport("section")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("score")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("weight")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("label")}
                  </th>
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
    </div>
  );
}

// ─── Main section: key selector + selected key's report ───────────────────────

export function ProjectScoreSection() {
  const t = useTranslations("evaluator.projects");
  const tCommon = useTranslations("common");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);

  // Own scope (no orgId) — the caller's opted-in, non-revoked keys.
  const {
    data: projectKeys,
    isLoading,
    error,
  } = trpc.reports.listProjectKeys.useQuery({});

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {tCommon("loading")}
        </CardContent>
      </Card>
    );
  }

  // The section is a secondary affordance; if its own query fails we hide it
  // rather than break the surrounding profile page.
  if (error) return null;

  if (!projectKeys || projectKeys.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("noKeys")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noKeysHint")}</p>
        </CardContent>
      </Card>
    );
  }

  const selectedKey = selectedKeyId
    ? projectKeys.find((k) => k.id === selectedKeyId)
    : undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="sr-only" htmlFor="project-score-select">
            {t("selectPlaceholder")}
          </label>
          <select
            id="project-score-select"
            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={selectedKeyId ?? ""}
            onChange={(e) => setSelectedKeyId(e.target.value || null)}
          >
            <option value="">{t("selectPlaceholder")}</option>
            {projectKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {selectedKey && <ProjectKeyReport apiKeyId={selectedKey.id} />}
    </div>
  );
}
