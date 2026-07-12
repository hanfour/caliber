import { and, eq, isNull, or } from "drizzle-orm";
import { organizations, rubrics, type Database } from "@caliber/db";
import { rubricSchema, type Rubric } from "@caliber/evaluator";

export interface ReportRubric {
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  source: "org" | "platform";
}

/** Resolve the same per-person rubric precedence used by the evaluator worker. */
export async function resolveReportRubric(
  db: Database,
  orgId: string,
  locale: "en" | "zh-Hant" | "ja" = "en",
): Promise<ReportRubric> {
  const [org] = await db
    .select({ rubricId: organizations.rubricId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (org?.rubricId) {
    const [custom] = await db
      .select()
      .from(rubrics)
      .where(
        and(
          eq(rubrics.id, org.rubricId),
          isNull(rubrics.deletedAt),
          isNull(rubrics.apiKeyId),
          or(isNull(rubrics.orgId), eq(rubrics.orgId, orgId)),
        ),
      )
      .limit(1);
    if (custom) {
      return {
        rubric: rubricSchema.parse(custom.definition),
        rubricId: custom.id,
        rubricVersion: custom.version,
        source: "org",
      };
    }
  }

  const defaults = await db
    .select()
    .from(rubrics)
    .where(
      and(
        isNull(rubrics.orgId),
        eq(rubrics.isDefault, true),
        isNull(rubrics.deletedAt),
        isNull(rubrics.apiKeyId),
      ),
    );
  const parsed = defaults.flatMap((row) => {
    const result = rubricSchema.safeParse(row.definition);
    return result.success ? [{ row, rubric: result.data }] : [];
  });
  const selected =
    parsed.find((item) => item.rubric.locale === locale) ??
    parsed.find((item) => item.rubric.locale === "en") ??
    parsed[0];
  if (!selected) throw new Error(`No platform-default rubric found (locale=${locale})`);
  return {
    rubric: selected.rubric,
    rubricId: selected.row.id,
    rubricVersion: selected.row.version,
    source: "platform",
  };
}
