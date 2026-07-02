"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { usePermissions } from "@/lib/usePermissions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TrendChart } from "./TrendChart";
import {
  scoreBadgeClass,
  SectionRow,
} from "./reportDetailShared";
import type { SectionResult } from "./reportDetailShared";
import type { ScorePoint } from "./TrendChart";
import { RubricEditor } from "./RubricEditor";

// ─── Per-key report renderer ──────────────────────────────────────────────────
// Fetches the by-key endpoints and renders the SAME visual structure as the
// per-person report (score badge + TrendChart + narrative + section table),
// rather than introducing a new visual design.

interface ProjectKeyReportProps {
  apiKeyId: string;
  isRevoked: boolean;
}

function ProjectKeyReport({ apiKeyId, isRevoked }: ProjectKeyReportProps) {
  const t = useTranslations("evaluator.projects");
  const tReport = useTranslations("evaluator.report");

  // Memoise the 30-day window so the query key is stable across renders.
  // Without this `new Date()` runs every render → tRPC refetches forever and
  // `isLoading` stays pinned to true (same fix as ProfileEvaluation).
  const { rangeFrom, rangeTo } = useMemo(() => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return {
      rangeFrom: thirtyDaysAgo.toISOString(),
      rangeTo: now.toISOString(),
    };
  }, []);

  const { data: latest, isLoading: latestLoading } =
    trpc.reports.getOwnByKeyLatest.useQuery({ apiKeyId });
  const { data: range, isLoading: rangeLoading } =
    trpc.reports.getOwnByKeyRange.useQuery({
      apiKeyId,
      from: rangeFrom,
      to: rangeTo,
    });

  if (latestLoading || rangeLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {tReport("loading")}
        </CardContent>
      </Card>
    );
  }

  if (!latest) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {t("noReport")}
        </CardContent>
      </Card>
    );
  }

  const latestScore = parseFloat(latest.totalScore);

  // Build 30-day trend series: oldest → newest (immutable copy before reverse).
  const trendSeries: ScorePoint[] = [...(range ?? [])].reverse().map((r) => ({
    date: new Date(r.periodStart).toISOString().slice(0, 10),
    score: parseFloat(r.totalScore),
  }));

  const sectionScores: SectionResult[] = Array.isArray(latest.sectionScores)
    ? (latest.sectionScores as SectionResult[])
    : [];

  const hasLlmNarrative =
    typeof latest.llmNarrative === "string" && latest.llmNarrative.length > 0;

  const keyName =
    "keyNameSnapshot" in latest && typeof latest.keyNameSnapshot === "string"
      ? latest.keyNameSnapshot
      : undefined;

  return (
    <div className="space-y-4">
      {/* Revoked notice — rendered before the report, read-only indicator */}
      {isRevoked && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="revoked-notice"
        >
          {t("revokedBadge")} — {keyName ? t("keyLabel", { name: keyName }) : null}
        </p>
      )}

      {/* Latest score + trend chart */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription>
              {tReport("thirtyDayWindow", {
                date: new Date(latest.periodStart).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </CardDescription>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ring-1 ${scoreBadgeClass(latestScore)}`}
          >
            {latestScore.toFixed(1)}
          </span>
        </CardHeader>
        <CardContent>
          <TrendChart series={trendSeries} />
        </CardContent>
      </Card>

      {/* LLM narrative — owner always has full visibility */}
      {hasLlmNarrative && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {tReport("aiNarrative")}
            </CardTitle>
            <CardDescription className="text-xs">
              {latest.llmCalledAt
                ? tReport("generatedByDate", {
                    model: latest.llmModel ?? "LLM",
                    date: new Date(latest.llmCalledAt).toLocaleDateString(),
                  })
                : tReport("generatedBy", { model: latest.llmModel ?? "LLM" })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {latest.llmNarrative}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Section scores table */}
      {sectionScores.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              {tReport("sectionScores")}
            </CardTitle>
            <CardDescription className="text-xs">
              {tReport("clickToExpand")}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">
                    {tReport("section")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("score")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("weight")}
                  </th>
                  <th className="px-4 py-2 text-center font-medium">
                    {tReport("label")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sectionScores.map((section) => (
                  <SectionRow key={section.sectionId} section={section} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main section: key selector + selected key's report ───────────────────────

export function ProjectScoreSection() {
  const t = useTranslations("evaluator.projects");
  const tKeyScope = useTranslations("evaluator.rubrics.keyScope");
  const tCommon = useTranslations("common");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [showRubricEditor, setShowRubricEditor] = useState(false);
  const { session } = usePermissions();
  const primaryOrgId = session?.coveredOrgs[0] ?? "";

  // Own scope (no orgId) — the caller's opted-in keys (active + revoked-with-history).
  const {
    data: projectKeys,
    isLoading,
    error,
  } = trpc.reports.listProjectKeys.useQuery({});

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          {tCommon("loading")}
        </CardContent>
      </Card>
    );
  }

  // The section is a secondary affordance; if its own query fails we hide it
  // rather than break the surrounding profile page.
  if (error) return null;

  if (!projectKeys || projectKeys.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("noKeys")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("noKeysHint")}</p>
        </CardContent>
      </Card>
    );
  }

  const selectedKey = selectedKeyId
    ? projectKeys.find((k) => k.id === selectedKeyId)
    : undefined;

  const isRevoked = selectedKey?.revokedAt != null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="sr-only" htmlFor="project-score-select">
            {t("selectPlaceholder")}
          </label>
          <select
            id="project-score-select"
            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={selectedKeyId ?? ""}
            onChange={(e) => {
              setSelectedKeyId(e.target.value || null);
              setShowRubricEditor(false);
            }}
          >
            <option value="">{t("selectPlaceholder")}</option>
            {projectKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.revokedAt != null
                  ? `${k.name} (${t("revokedBadge")})`
                  : k.name}
              </option>
            ))}
          </select>
          {/* Customize rubric — only for active (non-revoked) keys.
              NOTE: source badge intentionally omitted — the `source` field
              (key | org | platform) is not stored in the DB and is not
              returned by getOwnByKeyLatest. */}
          {selectedKey && !isRevoked && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRubricEditor(true)}
              >
                {tKeyScope("editButton")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedKey && (
        <ProjectKeyReport apiKeyId={selectedKey.id} isRevoked={isRevoked} />
      )}

      {showRubricEditor && selectedKey && (
        <RubricEditor
          target={{ scope: "key", apiKeyId: selectedKey.id, orgId: primaryOrgId }}
          onSuccess={() => setShowRubricEditor(false)}
          onCancel={() => setShowRubricEditor(false)}
        />
      )}
    </div>
  );
}
