"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Target,
} from "lucide-react";
import {
  adminAudienceReportSchema,
  userAudienceReportSchema,
} from "@caliber/evaluator";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Props {
  audience: "user" | "admin" | "redacted";
  report: unknown;
  model?: string | null;
  generatedAt?: string | Date | null;
}

export function GeneratedAudienceReport({
  audience,
  report,
  model,
  generatedAt,
}: Props) {
  const t = useTranslations("evaluator.audienceReport");
  const userResult =
    audience === "user" ? userAudienceReportSchema.safeParse(report) : null;
  const adminResult =
    audience === "admin" ? adminAudienceReportSchema.safeParse(report) : null;

  if (!userResult?.success && !adminResult?.success) return null;

  const generatedDescription = generatedAt
    ? t("generatedByDate", {
        model: model ?? "LLM",
        date: new Date(generatedAt).toLocaleDateString(),
      })
    : t("generatedBy", { model: model ?? "LLM" });

  if (userResult?.success) {
    const userReport = userResult.data;
    return (
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">{userReport.title}</CardTitle>
              <CardDescription>{generatedDescription}</CardDescription>
            </div>
            <AudienceLabel>{t("userLabel")}</AudienceLabel>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm leading-6 whitespace-pre-wrap">
            {userReport.summary}
          </p>

          {userReport.strengths.length > 0 && (
            <ReportSection title={t("strengths")} icon={CheckCircle2}>
              {userReport.strengths.map((item) => (
                <InsightRow key={`${item.sectionId}:${item.title}`} item={item} />
              ))}
            </ReportSection>
          )}

          {userReport.growthAreas.length > 0 && (
            <ReportSection title={t("growthAreas")} icon={Target}>
              {userReport.growthAreas.map((item) => (
                <InsightRow
                  key={`${item.sectionId}:${item.title}`}
                  item={item}
                  footer={item.action}
                />
              ))}
            </ReportSection>
          )}

          {userReport.nextSteps.length > 0 && (
            <ReportSection title={t("nextSteps")} icon={ClipboardCheck}>
              {userReport.nextSteps.map((item, index) => (
                <ActionRow key={`${item.title}:${index}`} index={index + 1} item={item} />
              ))}
            </ReportSection>
          )}
        </CardContent>
      </Card>
    );
  }

  if (!adminResult?.success) return null;
  const adminReport = adminResult.data;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">{adminReport.title}</CardTitle>
            <CardDescription>{generatedDescription}</CardDescription>
          </div>
          <AudienceLabel>{t("adminLabel")}</AudienceLabel>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("executiveSummary")}</h3>
          <p className="text-sm leading-6 whitespace-pre-wrap">
            {adminReport.executiveSummary}
          </p>
        </div>

        <ReportSection title={t("performanceAssessment")} icon={ClipboardCheck}>
          <p className="text-sm leading-6 whitespace-pre-wrap">
            {adminReport.performanceAssessment}
          </p>
        </ReportSection>

        {adminReport.strengths.length > 0 && (
          <ReportSection title={t("strengths")} icon={CheckCircle2}>
            {adminReport.strengths.map((item) => (
              <InsightRow key={`${item.sectionId}:${item.title}`} item={item} />
            ))}
          </ReportSection>
        )}

        {adminReport.concerns.length > 0 && (
          <ReportSection title={t("concerns")} icon={AlertTriangle}>
            {adminReport.concerns.map((item) => (
              <InsightRow
                key={`${item.sectionId}:${item.title}`}
                item={item}
                badge={t(`priority.${item.severity}`)}
                footer={
                  item.evidenceRequestIds.length > 0
                    ? t("evidenceCount", { count: item.evidenceRequestIds.length })
                    : undefined
                }
              />
            ))}
          </ReportSection>
        )}

        {adminReport.coachingPlan.length > 0 && (
          <ReportSection title={t("coachingPlan")} icon={Target}>
            {adminReport.coachingPlan.map((item, index) => (
              <ActionRow
                key={`${item.title}:${index}`}
                index={index + 1}
                item={item}
                footer={t("successMeasure", { measure: item.successMeasure })}
              />
            ))}
          </ReportSection>
        )}

        {(adminReport.calibrationNotes.length > 0 ||
          adminReport.dataLimitations.length > 0) && (
          <div className="grid gap-6 border-t pt-5 md:grid-cols-2">
            <TextList title={t("calibrationNotes")} items={adminReport.calibrationNotes} />
            <TextList title={t("dataLimitations")} items={adminReport.dataLimitations} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AudienceLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function ReportSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof CheckCircle2;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function InsightRow({
  item,
  badge,
  footer,
}: {
  item: { sectionId: string; title: string; detail: string };
  badge?: string;
  footer?: string;
}) {
  return (
    <div className="border-l-2 border-border pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{item.title}</p>
        <span className="font-mono text-[10px] text-muted-foreground">
          {item.sectionId}
        </span>
        {badge && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.detail}</p>
      {footer && <p className="mt-1.5 text-xs font-medium">{footer}</p>}
    </div>
  );
}

function ActionRow({
  index,
  item,
  footer,
}: {
  index: number;
  item: { title: string; rationale: string; priority: "high" | "medium" | "low" };
  footer?: string;
}) {
  const t = useTranslations("evaluator.audienceReport");
  return (
    <div className="grid grid-cols-[1.75rem_1fr] gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">
        {index}
      </span>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{item.title}</p>
          <span className="text-[10px] font-medium uppercase text-muted-foreground">
            {t(`priority.${item.priority}`)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{item.rationale}</p>
        {footer && <p className="mt-1.5 text-xs font-medium">{footer}</p>}
      </div>
    </div>
  );
}

function TextList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2">
            <span aria-hidden="true">-</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
