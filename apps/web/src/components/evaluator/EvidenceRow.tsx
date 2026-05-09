"use client";

// Evidence quotes for a single rubric section, shown when a row is expanded.

import { useTranslations } from "next-intl";

export interface EvidenceItem {
  requestId?: string;
  quote: string;
  offset: number;
}

export interface SignalHitDisplay {
  id: string;
  hit: boolean;
  evidence?: EvidenceItem[];
}

interface Props {
  signals: SignalHitDisplay[];
}

export function EvidenceRow({ signals }: Props) {
  const t = useTranslations("evaluator.report");
  const hitsWithEvidence = signals.filter(
    (s) => s.hit && s.evidence && s.evidence.length > 0,
  );

  if (hitsWithEvidence.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        {t("noEvidence")}
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 py-3">
      {hitsWithEvidence.map((signal) => (
        <div key={signal.id} className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {t("evidenceTitle", { id: signal.id })}
          </p>
          {signal.evidence!.map((ev, idx) => (
            <div
              key={idx}
              className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1"
            >
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
      ))}
    </div>
  );
}
