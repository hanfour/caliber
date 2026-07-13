"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { SignalBreakdown, type BreakdownSignal } from "./SignalBreakdown";
import type { RubricSignal } from "./rubricThreshold";

// ─── Types (mirrors evaluator/engine/types.ts stored in jsonb) ────────────────

export interface EvidenceItem {
  requestId?: string;
  quote: string;
  offset: number;
}

export interface SignalHit {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
  /** v2: rows that actually carried data for this signal. */
  sampleCount?: number;
  /** v2 continuous: points earned after curve mapping (undefined when unusable). */
  earnedPoints?: number;
  /** v2 continuous: configured points for this signal. */
  maxPoints?: number;
}

export interface SectionResult {
  sectionId: string;
  name: string;
  weight: number;
  /** v2: which scorer produced this result. Legacy rows lack the field. */
  mode?: "tiered" | "continuous";
  standardScore: number;
  superiorScore: number;
  /** null = insufficient data (continuous only). Tiered is always numeric. */
  score: number | null;
  /** v2 continuous: the scale max this section was scored against. */
  maxScore?: number;
  label: string;
  signals: SignalHit[];
}

// ─── Score colour helpers ─────────────────────────────────────────────────────

export function scoreColorClass(score: number | null): string {
  if (score === null) return "text-zinc-500 dark:text-zinc-400";
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

export function scoreBadgeClass(score: number | null): string {
  if (score === null)
    return "bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700";
  if (score >= 100)
    return "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800";
  if (score >= 80)
    return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800";
  return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800";
}

// ─── Section row with expand/collapse ────────────────────────────────────────

interface SectionRowProps {
  section: SectionResult;
  rubricSection?: { signals: RubricSignal[] };
}

export function SectionRow({ section, rubricSection }: SectionRowProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslations("evaluator.report");

  const signals: BreakdownSignal[] = section.signals.map((s) => ({
    id: s.id,
    type: s.type,
    hit: s.hit,
    value: s.value,
    evidence: s.evidence,
    sampleCount: s.sampleCount,
    earnedPoints: s.earnedPoints,
    maxPoints: s.maxPoints,
  }));

  const rubricSignals: Record<string, RubricSignal> | undefined = rubricSection
    ? Object.fromEntries(rubricSection.signals.map((rs) => [rs.id, rs]))
    : undefined;

  const isSuperior =
    section.mode !== "continuous" &&
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
          {section.score === null ? (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-400 dark:ring-zinc-700">
              {t("insufficientData")}
            </span>
          ) : (
            <span
              className={`text-sm font-semibold tabular-nums ${scoreColorClass(section.score)}`}
            >
              {section.mode === "continuous"
                ? `${section.score.toFixed(1)} / ${section.maxScore ?? section.superiorScore}`
                : section.score}
            </span>
          )}
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
            <SignalBreakdown signals={signals} rubricSignals={rubricSignals} />
          </td>
        </tr>
      )}
    </>
  );
}
