"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { EvidenceRow } from "./EvidenceRow";
import type { SignalHitDisplay } from "./EvidenceRow";

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
}

export interface SectionResult {
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

export function scoreColorClass(score: number): string {
  if (score >= 100) return "text-sky-600 dark:text-sky-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

export function scoreBadgeClass(score: number): string {
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

export function SectionRow({ section }: SectionRowProps) {
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
