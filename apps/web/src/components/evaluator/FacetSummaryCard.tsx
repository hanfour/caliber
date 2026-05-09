"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Props {
  orgId: string;
  userId: string;
  /** ISO timestamp marking the lower bound of the report window. */
  rangeFrom: string;
  /** ISO timestamp marking the upper bound of the report window. */
  rangeTo: string;
}

function fmtPercent(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function fmtNumber(v: number | null, digits = 0): string {
  if (v == null) return "—";
  return v.toFixed(digits);
}

/**
 * Renders the facet-extraction aggregate for the report subject's window.
 * Hidden entirely when no facet rows exist (the empty case is silent so
 * the report page doesn't sprout an empty drill-down for orgs that haven't
 * enabled facet extraction).
 *
 * Plan 4C follow-up #3.
 */
export function FacetSummaryCard({ orgId, userId, rangeFrom, rangeTo }: Props) {
  const t = useTranslations("evaluator.facetSummary");
  const { data, isLoading, error } = trpc.reports.facetSummary.useQuery({
    orgId,
    userId,
    range: { from: rangeFrom, to: rangeTo },
  });

  const SESSION_TYPE_LABEL: Record<string, string> = {
    feature_dev: t("sessionTypeFeatureDev"),
    bug_fix: t("sessionTypeBugFix"),
    refactor: t("sessionTypeRefactor"),
    exploration: t("sessionTypeExploration"),
    other: t("sessionTypeOther"),
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">
            {t("loading")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-destructive">
            {t("loadFail", { message: error.message })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.total === 0) return null; // silent hide

  const sessionTypeEntries = Object.entries(data.sessionTypeCounts).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>
          {t("description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs uppercase">{t("sessions")}</dt>
            <dd className="text-base font-medium tabular-nums">{data.total}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("successRate")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {fmtPercent(data.outcomeSuccessRate)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("avgHelpfulness")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {data.avgClaudeHelpfulness == null
                ? "—"
                : `${data.avgClaudeHelpfulness.toFixed(1)} / 5`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("failedExtractions")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {data.failed}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("bugsCaught")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {fmtNumber(data.totalBugsCaught)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("frictionEvents")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {fmtNumber(data.totalFrictionCount)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">
              {t("codexErrors")}
            </dt>
            <dd className="text-base font-medium tabular-nums">
              {fmtNumber(data.totalCodexErrors)}
            </dd>
          </div>
        </dl>

        {sessionTypeEntries.length > 0 && (
          <div>
            <h3 className="text-xs uppercase text-muted-foreground mb-2">
              {t("sessionTypes")}
            </h3>
            <ul className="flex flex-wrap gap-2 text-xs">
              {sessionTypeEntries.map(([key, count]) => (
                <li
                  key={key}
                  className="px-2 py-1 rounded-full border bg-muted/40"
                >
                  <span className="font-medium">
                    {SESSION_TYPE_LABEL[key] ?? key}
                  </span>
                  <span className="ml-1 text-muted-foreground tabular-nums">
                    ({count})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
