"use client";

import { useTranslations } from "next-intl";

/** Preset look-back windows (in days) offered by the evaluation range selector. */
export const WINDOW_PRESETS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_PRESETS)[number];

/** The rerun backend caps a single re-evaluation window at 92 days (one quarter).
 * Keep in sync with MAX_RERUN_WINDOW_DAYS in apps/api/.../reports.ts. */
export const RERUN_MAX_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A window is either a rolling preset (last N days), the last completed
 * calendar quarter, or an explicit custom calendar range. Custom dates are
 * stored as `YYYY-MM-DD` (native date-input format) and only widened to an
 * ISO instant in {@link selectionToRange}.
 */
export type WindowSelection =
  | { mode: "preset"; days: WindowDays }
  | { mode: "quarter" }
  | { mode: "custom"; fromDate: string; toDate: string };

export const DEFAULT_SELECTION: WindowSelection = { mode: "preset", days: 30 };

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO range for the last `days` days, ending now. */
export function windowRange(days: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * DAY_MS);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** A custom selection seeded with the last 30 days (valid + editable). */
export function defaultCustomSelection(): WindowSelection {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * DAY_MS);
  return { mode: "custom", fromDate: isoDay(from), toDate: isoDay(to) };
}

export interface Quarter {
  year: number;
  quarter: number; // 1-4
  from: string;
  to: string;
}

/** The most recent COMPLETED calendar quarter (local time). now in Q3 → Q2;
 * now in Q1 → previous year's Q4. Always a fully-past, ≤92-day span. */
export function lastCompletedQuarter(): Quarter {
  const now = new Date();
  let year = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3) - 1; // 0-3
  if (q < 0) {
    q = 3;
    year -= 1;
  }
  const startMonth = q * 3;
  const from = new Date(year, startMonth, 1, 0, 0, 0, 0);
  const to = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  return { year, quarter: q + 1, from: from.toISOString(), to: to.toISOString() };
}

/**
 * Resolve a selection to an ISO `[from, to]` range. A custom range covers whole
 * days (00:00:00 → 23:59:59.999). An incomplete or inverted custom range falls
 * back to the last 30 days so the report query always has a valid window.
 */
export function selectionToRange(sel: WindowSelection): {
  from: string;
  to: string;
} {
  if (sel.mode === "quarter") {
    const q = lastCompletedQuarter();
    return { from: q.from, to: q.to };
  }
  if (sel.mode === "custom") {
    const fromMs = Date.parse(`${sel.fromDate}T00:00:00`);
    const toMs = Date.parse(`${sel.toDate}T23:59:59.999`);
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && fromMs <= toMs) {
      return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    }
    return windowRange(30);
  }
  return windowRange(sel.days);
}

/** Whole days spanned by a range (used to gate the rerun to RERUN_MAX_DAYS). */
export function rangeDays(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / DAY_MS;
}

interface Props {
  value: WindowSelection;
  onChange: (sel: WindowSelection) => void;
}

/** Segmented control (7/30/90-day presets + a custom calendar range). */
export function EvaluationWindowSelect({ value, onChange }: Props) {
  const t = useTranslations("evaluator.report");
  const activeDays = value.mode === "preset" ? value.days : null;
  const isCustom = value.mode === "custom";
  const isQuarter = value.mode === "quarter";

  return (
    <div className="flex flex-col items-end gap-2">
      <div
        role="group"
        aria-label={t("windowSelectLabel")}
        className="inline-flex rounded-md border border-border p-0.5"
      >
        {WINDOW_PRESETS.map((days) => (
          <button
            key={days}
            type="button"
            aria-pressed={activeDays === days}
            onClick={() => onChange({ mode: "preset", days })}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              activeDays === days
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("windowOption", { days })}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={isQuarter}
          onClick={() => onChange({ mode: "quarter" })}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            isQuarter
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("windowQuarter")}
        </button>
        <button
          type="button"
          aria-pressed={isCustom}
          onClick={() =>
            onChange(isCustom ? value : defaultCustomSelection())
          }
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            isCustom
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("windowCustom")}
        </button>
      </div>

      {isCustom && (
        <div className="flex items-center gap-2 text-xs">
          <input
            type="date"
            aria-label={t("windowFrom")}
            value={value.fromDate}
            max={value.toDate}
            onChange={(e) =>
              onChange({ ...value, fromDate: e.target.value })
            }
            className="rounded border border-border bg-background px-2 py-1"
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="date"
            aria-label={t("windowTo")}
            value={value.toDate}
            min={value.fromDate}
            onChange={(e) => onChange({ ...value, toDate: e.target.value })}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </div>
      )}
    </div>
  );
}
