"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LlmEvidence {
  quote: string;
  requestId: string;
  rationale: string;
}

function parse(evidence: unknown): LlmEvidence[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (e): e is LlmEvidence =>
      !!e &&
      typeof (e as LlmEvidence).quote === "string" &&
      typeof (e as LlmEvidence).rationale === "string" &&
      typeof (e as LlmEvidence).requestId === "string",
  );
}

export function LlmEvidenceList({ evidence }: { evidence?: unknown }) {
  const t = useTranslations("evaluator.llmEvidence");
  const items = parse(evidence);
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((ev, idx) => (
          <div key={idx} className="rounded-md border border-border bg-muted/20 px-3 py-2 space-y-1">
            <blockquote className="text-xs italic text-foreground leading-relaxed">
              &ldquo;{ev.quote}&rdquo;
            </blockquote>
            <p className="text-xs text-muted-foreground">{ev.rationale}</p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {t("requestId")} <span className="select-all">{ev.requestId}</span>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
