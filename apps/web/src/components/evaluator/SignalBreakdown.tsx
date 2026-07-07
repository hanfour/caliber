// apps/web/src/components/evaluator/SignalBreakdown.tsx
"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatThreshold, type RubricSignal } from "./rubricThreshold";
import type { EvidenceItem } from "./EvidenceRow";

export interface BreakdownSignal {
  id: string;
  type: string;
  hit: boolean;
  value?: number;
  evidence?: EvidenceItem[];
}

interface Props {
  signals: BreakdownSignal[];
  rubricSignals?: Record<string, RubricSignal>;
}

export function SignalBreakdown({ signals, rubricSignals }: Props) {
  const t = useTranslations("evaluator.report");

  if (signals.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        {t("noSignals")}
      </div>
    );
  }

  return (
    <div className="space-y-2 px-4 py-3">
      {signals.map((s) => {
        const rubricSignal = rubricSignals?.[s.id];
        const threshold = rubricSignal ? formatThreshold(rubricSignal) : "";
        const evidence =
          s.hit && s.evidence && s.evidence.length > 0 ? s.evidence : [];
        return (
          <div
            key={s.id}
            data-testid={`signal-${s.id}`}
            data-hit={s.hit ? "true" : "false"}
            className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1"
          >
            <div className="flex items-center gap-2">
              {s.hit ? (
                <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <X className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <span className="font-mono text-xs font-medium">{s.id}</span>
              {s.value != null && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {t("actualValue", { value: s.value })}
                </span>
              )}
            </div>
            {threshold && (
              <p className="ml-5.5 text-[10px] text-muted-foreground">
                {t("thresholdLabel")}{" "}
                <span className="font-mono">{threshold}</span>
              </p>
            )}
            {evidence.map((ev, idx) => (
              <div key={idx} className="ml-5.5 space-y-1">
                <blockquote className="text-xs italic text-foreground leading-relaxed">
                  &ldquo;{ev.quote}&rdquo;
                </blockquote>
                {ev.requestId && (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {t("requestId")}{" "}
                    <span className="select-all">{ev.requestId}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
