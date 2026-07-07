"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  sourceBreakdown?: { gateway_events?: number; transcript_events?: number; overlap?: number } | null;
  dataQuality?: {
    coverageRatio?: number;
    capturedRequests?: number;
    missingBodies?: number;
    truncatedBodies?: number;
    totalRequests?: number;
  } | null;
  period?: { requestCount?: number; bodyCount?: number } | null;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Renders the report's data-source split (gateway vs telemetry events) and
 * body-coverage stats so viewers can see what the score was computed from.
 * Hidden entirely when no data-quality object exists (nothing to explain).
 */
export function DataProvenanceCard({ sourceBreakdown, dataQuality, period }: Props) {
  const t = useTranslations("evaluator.provenance");
  if (!dataQuality) return null;

  const coverage =
    dataQuality.coverageRatio != null
      ? `${Math.round(dataQuality.coverageRatio * 100)}%`
      : "—";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label={t("gatewayEvents")} value={sourceBreakdown?.gateway_events ?? 0} />
          <Stat label={t("telemetryEvents")} value={sourceBreakdown?.transcript_events ?? 0} />
          <Stat label={t("coverage")} value={coverage} />
          <Stat label={t("captured")} value={dataQuality.capturedRequests ?? 0} />
          {dataQuality.missingBodies != null && (
            <Stat label={t("missingBodies")} value={dataQuality.missingBodies} />
          )}
          {dataQuality.truncatedBodies != null && (
            <Stat label={t("truncatedBodies")} value={dataQuality.truncatedBodies} />
          )}
          {period?.requestCount != null && (
            <Stat label={t("requests")} value={period.requestCount} />
          )}
          {period?.bodyCount != null && (
            <Stat label={t("bodies")} value={period.bodyCount} />
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
