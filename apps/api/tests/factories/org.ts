import { organizations, departments, teams } from "@caliber/db";
import type { Database } from "@caliber/db";

let counter = 0;
const uniq = () => `${Date.now()}-${counter++}`;

export async function makeOrg(
  db: Database,
  overrides: Partial<{
    slug: string;
    name: string;
    contentCaptureEnabled?: boolean;
    retentionDaysOverride?: number;
    llmEvalEnabled?: boolean;
  }> = {},
) {
  const slug = overrides.slug ?? `org-${uniq()}`;
  const [row] = await db
    .insert(organizations)
    .values({
      slug,
      name: overrides.name ?? slug,
      contentCaptureEnabled: overrides.contentCaptureEnabled ?? false,
      retentionDaysOverride: overrides.retentionDaysOverride,
      llmEvalEnabled: overrides.llmEvalEnabled ?? false,
    })
    .returning();
  return row!;
}

export async function makeDept(
  db: Database,
  orgId: string,
  overrides: Partial<{ slug: string; name: string }> = {},
) {
  const slug = overrides.slug ?? `dept-${uniq()}`;
  const [row] = await db
    .insert(departments)
    .values({ orgId, slug, name: overrides.name ?? slug })
    .returning();
  return row!;
}

export async function makeTeam(
  db: Database,
  orgId: string,
  overrides: Partial<{
    departmentId: string | null;
    slug: string;
    name: string;
  }> = {},
) {
  const slug = overrides.slug ?? `team-${uniq()}`;
  const [row] = await db
    .insert(teams)
    .values({
      orgId,
      departmentId: overrides.departmentId ?? null,
      slug,
      name: overrides.name ?? slug,
    })
    .returning();
  return row!;
}
