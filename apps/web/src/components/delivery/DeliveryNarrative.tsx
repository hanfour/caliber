"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ─── Types (mirrors the llmEvidence jsonb shape persisted by
// apps/gateway/src/workers/githubDelivery/runDeliveryEval.ts) ─────────────────

interface DeliveryEvidenceItem {
  repo: string;
  prNumber: number;
  quote: string;
  reason: string;
}

/**
 * Defensive parse: the LLM's raw JSON output is untrusted at this boundary
 * (same discipline as ReportDetail's evidence rendering) — a non-object item
 * (e.g. a stray string) or one missing `repo`/`prNumber` is dropped rather
 * than crashing the render.
 */
function toEvidenceItem(item: unknown): DeliveryEvidenceItem | null {
  if (!item || typeof item !== "object") return null;
  const candidate = item as Record<string, unknown>;
  if (typeof candidate.repo !== "string" || candidate.repo.length === 0) return null;
  if (typeof candidate.prNumber !== "number" || !Number.isFinite(candidate.prNumber)) {
    return null;
  }
  return {
    repo: candidate.repo,
    prNumber: candidate.prNumber,
    quote: typeof candidate.quote === "string" ? candidate.quote : "",
    reason: typeof candidate.reason === "string" ? candidate.reason : "",
  };
}

interface Props {
  report: {
    llmStatus: string | null;
    llmNarrative?: string | null;
    llmEvidence?: unknown;
  };
}

export function DeliveryNarrative({ report }: Props) {
  const t = useTranslations("evaluator.delivery");

  // Belt and braces: the parent (DeliveryDetail) only mounts this component
  // inside the full-report branch, but the LLM layer's status is orthogonal
  // to whether a report exists at all — re-check here so this component is
  // safe to render standalone too.
  if (report.llmStatus !== "ok") return null;

  const evidence: DeliveryEvidenceItem[] = Array.isArray(report.llmEvidence)
    ? report.llmEvidence.map(toEvidenceItem).filter((item): item is DeliveryEvidenceItem => item !== null)
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("narrativeTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {report.llmNarrative && (
          <p className="text-sm text-foreground whitespace-pre-wrap">{report.llmNarrative}</p>
        )}

        {evidence.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("evidenceTitle")}
            </h4>
            <ul className="space-y-3">
              {evidence.map((item, idx) => (
                <li key={`${item.repo}-${item.prNumber}-${idx}`} className="space-y-1">
                  <a
                    href={`https://github.com/${item.repo}/pull/${item.prNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    {item.repo}#{item.prNumber}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  <blockquote className="border-l-2 border-border pl-3 text-sm italic text-foreground">
                    {item.quote}
                  </blockquote>
                  {item.reason && (
                    <p className="text-xs text-muted-foreground">{item.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
