"use client";

import { useTranslations } from "next-intl";

/** Preset look-back windows (in days) offered by the evaluation range selector. */
export const WINDOW_PRESETS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_PRESETS)[number];

export const DEFAULT_WINDOW_DAYS: WindowDays = 30;

/**
 * Compute an ISO `[from, to]` range for the last `days` days. `to` is captured
 * once per `days` change (callers memoize on `days`) so the query key stays
 * stable across renders — a bare `new Date()` every render loops tRPC.
 */
export function windowRange(days: WindowDays): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

interface Props {
  value: WindowDays;
  onChange: (days: WindowDays) => void;
}

/** Segmented control to pick the evaluation look-back window. */
export function EvaluationWindowSelect({ value, onChange }: Props) {
  const t = useTranslations("evaluator.report");
  return (
    <div
      role="group"
      aria-label={t("windowSelectLabel")}
      className="inline-flex rounded-md border border-border p-0.5"
    >
      {WINDOW_PRESETS.map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={value === days}
          onClick={() => onChange(days)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === days
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("windowOption", { days })}
        </button>
      ))}
    </div>
  );
}
