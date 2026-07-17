"use client";

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ─── Types (mirrors the select maps in
// apps/api/src/trpc/routers/githubDelivery.ts `listActivity`) ─────────────────

interface PullRow {
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  ghCreatedAt: string;
  mergedAt: string | null;
}

interface IssueRow {
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  ghCreatedAt: string;
  closedAt: string | null;
}

// NOTE: reviews carry `repoFullName` + `prGhNodeId` (a GraphQL node id, not a
// PR number) + `state` + `submittedAt` — no PR number and no htmlUrl are
// selected server-side, so a `repo#number` link (as rendered for pulls/
// issues) isn't buildable here. Per the task brief's explicit fallback,
// review rows render `state · date` only.
interface ReviewRow {
  repoFullName: string | null;
  prGhNodeId: string | null;
  state: string;
  submittedAt: string;
}

interface ListActivityResult {
  ghUserId: number | null;
  pulls: PullRow[];
  issues: IssueRow[];
  reviews: ReviewRow[];
}

interface Props {
  orgId: string;
  userId: string;
  from: string;
  to: string;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function ActivitySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

export function DeliveryActivityList({ orgId, userId, from, to }: Props) {
  const t = useTranslations("evaluator.delivery");
  const { data, isLoading, error } = trpc.githubDelivery.listActivity.useQuery({
    orgId,
    userId,
    from,
    to,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    const code = (error.data as { code?: string } | undefined)?.code;
    // NOT_FOUND means the feature flag is off — the parent DeliveryDetail
    // already renders its own notEnabled card for that state, so this
    // component stays silent rather than duplicating the message.
    if (code === "NOT_FOUND") return null;
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground text-center">
          {error.message}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const activity = data as ListActivityResult;
  const { pulls, issues, reviews } = activity;
  const isAllEmpty = pulls.length === 0 && issues.length === 0 && reviews.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("activityTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {activity.ghUserId === null ? (
          <p className="text-sm text-muted-foreground">{t("noLinkedAccount")}</p>
        ) : isAllEmpty ? (
          <p className="text-sm text-muted-foreground">{t("noActivity")}</p>
        ) : (
          <>
            <ActivitySection title={`${t("pulls")} (${pulls.length})`}>
              {pulls.map((pr) => (
                <li key={`${pr.repoFullName}#${pr.number}`} className="space-y-0.5">
                  <a
                    href={pr.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    {pr.title}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  <div className="text-xs text-muted-foreground">
                    {pr.repoFullName}#{pr.number} · {formatDate(pr.mergedAt)}
                  </div>
                </li>
              ))}
            </ActivitySection>

            <ActivitySection title={`${t("issues")} (${issues.length})`}>
              {issues.map((issue) => (
                <li key={`${issue.repoFullName}#${issue.number}`} className="space-y-0.5">
                  <a
                    href={issue.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    {issue.title}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  <div className="text-xs text-muted-foreground">
                    {issue.repoFullName}#{issue.number} · {formatDate(issue.closedAt)}
                  </div>
                </li>
              ))}
            </ActivitySection>

            <ActivitySection title={`${t("reviews")} (${reviews.length})`}>
              {reviews.map((review, idx) => (
                <li
                  key={`${review.repoFullName ?? "review"}-${review.submittedAt}-${idx}`}
                  className="text-sm text-muted-foreground"
                >
                  {review.state} · {formatDate(review.submittedAt)}
                </li>
              ))}
            </ActivitySection>
          </>
        )}
      </CardContent>
    </Card>
  );
}
