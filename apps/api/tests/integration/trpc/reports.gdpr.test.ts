/**
 * PR7: GDPR export + cascade hardening integration tests.
 *
 * Tests three properties:
 *   A. exportOwn includes the caller's user-authored key rubrics
 *      (created_by=caller, api_key_id IS NOT NULL, deleted_at IS NULL).
 *   B. Org hard-delete cascade: a key rubric referenced by an
 *      evaluation_reports_by_key row does NOT abort on rubric_id RESTRICT,
 *      because the org → evaluation_reports_by_key ON DELETE CASCADE fires
 *      within the same statement as the api_key → rubric ON DELETE CASCADE,
 *      and PostgreSQL checks RESTRICT after all cascades in the statement.
 *   C. Soft-erasure (bodies_and_reports) keeps the key rubric row intact.
 *      A key rubric is project scoring config, not personal content; erasing
 *      the user's by-key reports does not drop the rubric (only a full user
 *      hard-delete with createdBy SET NULL removes the author link).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  organizations,
  users,
  apiKeys,
  rubrics,
  evaluationReportsByKey,
} from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { reportsRouter } from "../../../src/trpc/routers/reports.js";

const localRouter = router({ reports: reportsRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: {
  db: Database;
  userId: string;
  email?: string;
  env?: ServerEnv;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;

const minimalDef = () => ({
  name: "T",
  description: "d",
  version: "1.0.0",
  locale: "en",
  sections: [],
});

async function seedApiKey(
  db: Database,
  opts: { orgId: string; userId: string },
): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      name: `key-gdpr-${seedCounter}`,
      keyHash: `hash-gdpr-${seedCounter}-${Date.now()}`,
      keyPrefix: `sk-g${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedKeyRubric(
  db: Database,
  opts: { orgId: string; apiKeyId: string; createdBy: string },
): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId: opts.orgId,
      apiKeyId: opts.apiKeyId,
      createdBy: opts.createdBy,
      name: `Key Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: minimalDef() as unknown as Record<string, unknown>,
      isDefault: false,
    })
    .returning({ id: rubrics.id });
  return row!.id;
}

async function seedOrgRubric(
  db: Database,
  opts: { orgId: string; createdBy: string },
): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId: opts.orgId,
      createdBy: opts.createdBy,
      name: `Org Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: minimalDef() as unknown as Record<string, unknown>,
      isDefault: false,
    })
    .returning({ id: rubrics.id });
  return row!.id;
}

async function seedReportByKey(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    apiKeyId: string;
    rubricId: string;
  },
): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(evaluationReportsByKey)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      apiKeyId: opts.apiKeyId,
      keyNameSnapshot: `snap-${seedCounter}`,
      teamId: null,
      rubricId: opts.rubricId,
      rubricVersion: "1.0.0",
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-01-02"),
      periodType: "daily",
      totalScore: "85.0000",
      sectionScores: [],
      signalsSummary: {},
      dataQuality: { coverageRatio: 0.9, capturedRequests: 0 },
      llmNarrative: null,
      llmEvidence: null,
      llmModel: null,
      llmCalledAt: null,
      llmCostUsd: null,
      llmUpstreamAccountId: null,
      triggeredBy: "cron",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReportsByKey.id });
  return row!.id;
}

// ─── A: exportOwn includes key rubrics ────────────────────────────────────────

describe("PR7: exportOwn — key rubrics coverage", () => {
  it("includes the caller's live key rubrics (api_key_id IS NOT NULL)", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
    });
    const keyRubricId = await seedKeyRubric(t.db, {
      orgId: org.id,
      apiKeyId,
      createdBy: user.id,
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const result = await caller.reports.exportOwn();

    expect(result.keyRubrics).toBeDefined();
    const ids = result.keyRubrics.map((r) => r.id);
    expect(ids).toContain(keyRubricId);
  });

  it("does not include org-scoped rubrics (api_key_id IS NULL) authored by caller", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const orgRubricId = await seedOrgRubric(t.db, {
      orgId: org.id,
      createdBy: user.id,
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const result = await caller.reports.exportOwn();

    const ids = result.keyRubrics.map((r) => r.id);
    expect(ids).not.toContain(orgRubricId);
  });

  it("does not include key rubrics authored by a different user", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const other = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: other.id,
    });
    const otherRubricId = await seedKeyRubric(t.db, {
      orgId: org.id,
      apiKeyId,
      createdBy: other.id,
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const result = await caller.reports.exportOwn();

    const ids = result.keyRubrics.map((r) => r.id);
    expect(ids).not.toContain(otherRubricId);
  });

  it("does not include soft-deleted key rubrics", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
    });
    const softDeletedRubricId = await seedKeyRubric(t.db, {
      orgId: org.id,
      apiKeyId,
      createdBy: user.id,
    });
    // Soft-delete the rubric
    await t.db
      .update(rubrics)
      .set({ deletedAt: new Date() })
      .where(eq(rubrics.id, softDeletedRubricId));

    const caller = await callerFor({ db: t.db, userId: user.id });
    const result = await caller.reports.exportOwn();

    const ids = result.keyRubrics.map((r) => r.id);
    expect(ids).not.toContain(softDeletedRubricId);
  });

  it("returned key rubric rows include the required portability fields", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
    });
    await seedKeyRubric(t.db, {
      orgId: org.id,
      apiKeyId,
      createdBy: user.id,
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const result = await caller.reports.exportOwn();

    expect(result.keyRubrics.length).toBeGreaterThanOrEqual(1);
    const row = result.keyRubrics[0]!;
    expect(row.id).toBeTruthy();
    expect(row.apiKeyId).toBe(apiKeyId);
    expect(row.name).toBeTruthy();
    expect(row.version).toBeTruthy();
    expect(row.definition).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

// ─── B: cascade convergence — org hard-delete ─────────────────────────────────

describe("PR7: cascade hardening — org hard-delete", () => {
  it(
    "org hard-delete does NOT abort on evaluation_reports_by_key.rubric_id RESTRICT: " +
      "PG applies org→evaluation_reports_by_key CASCADE in the same statement as " +
      "api_key→rubric CASCADE, so RESTRICT check finds no referencing rows",
    async () => {
      // Isolate this test with its own fresh org/user/key so cleanup doesn't
      // affect other tests. Use raw inserts to avoid shared state.
      const [org] = await t.db
        .insert(organizations)
        .values({ slug: `cascade-test-org-${Date.now()}`, name: "Cascade Test Org" })
        .returning();
      const orgId = org!.id;

      const [user] = await t.db
        .insert(users)
        .values({ email: `cascade-test-${Date.now()}@example.com` })
        .returning();
      const userId = user!.id;

      const [key] = await t.db
        .insert(apiKeys)
        .values({
          orgId,
          userId,
          name: "cascade-test-key",
          keyHash: `hash-cascade-${Date.now()}`,
          keyPrefix: "ck-t",
        })
        .returning({ id: apiKeys.id });
      const apiKeyId = key!.id;

      // Seed a key rubric: api_key_id → ON DELETE CASCADE from key.
      // rubric_id on by-key reports is ON DELETE RESTRICT.
      const [rubric] = await t.db
        .insert(rubrics)
        .values({
          orgId,
          apiKeyId,
          createdBy: userId,
          name: "cascade-test-rubric",
          version: "1.0.0",
          definition: minimalDef() as unknown as Record<string, unknown>,
          isDefault: false,
        })
        .returning({ id: rubrics.id });
      const rubricId = rubric!.id;

      // Seed a by-key report that references the key rubric.
      // This creates the RESTRICT dependency: rubric → report.
      await t.db.insert(evaluationReportsByKey).values({
        orgId,
        userId,
        apiKeyId,
        keyNameSnapshot: "cascade-snap",
        rubricId,
        rubricVersion: "1.0.0",
        periodStart: new Date("2025-06-01"),
        periodEnd: new Date("2025-06-02"),
        periodType: "daily",
        totalScore: "80.0000",
        sectionScores: [],
        signalsSummary: {},
        dataQuality: {},
        llmNarrative: null,
        llmEvidence: null,
        llmModel: null,
        llmCalledAt: null,
        llmCostUsd: null,
        llmUpstreamAccountId: null,
        triggeredBy: "cron",
        triggeredByUser: null,
      });

      // Delete the org. This triggers:
      //   1. CASCADE: evaluation_reports_by_key.orgId → org (reports gone)
      //   2. CASCADE: api_keys.orgId → org (key gone)
      //   3. CASCADE: rubrics.api_key_id → key (rubric gone)
      //   RESTRICT check: evaluation_reports_by_key.rubric_id → rubric
      //     fires AFTER all cascades in the same statement → no rows left → OK.
      // This must NOT throw a FK violation.
      await expect(
        t.db
          .delete(organizations)
          .where(eq(organizations.id, orgId)),
      ).resolves.toBeDefined();

      // Verify all rows are gone.
      const remainingReports = await t.db
        .select({ id: evaluationReportsByKey.id })
        .from(evaluationReportsByKey)
        .where(eq(evaluationReportsByKey.orgId, orgId));
      expect(remainingReports).toHaveLength(0);

      const remainingRubrics = await t.db
        .select({ id: rubrics.id })
        .from(rubrics)
        .where(eq(rubrics.id, rubricId));
      expect(remainingRubrics).toHaveLength(0);
    },
  );
});

// ─── C: soft-erasure semantics ────────────────────────────────────────────────

describe("PR7: erasure semantics — soft erasure keeps key rubrics", () => {
  it(
    "bodies_and_reports soft-erasure: deleting evaluation_reports_by_key by (userId, orgId) " +
      "does NOT delete the key rubric (project config, not personal content)",
    async () => {
      const org = await makeOrg(t.db);
      const user = await makeUser(t.db, { orgId: org.id });
      const apiKeyId = await seedApiKey(t.db, {
        orgId: org.id,
        userId: user.id,
      });
      const keyRubricId = await seedKeyRubric(t.db, {
        orgId: org.id,
        apiKeyId,
        createdBy: user.id,
      });
      await seedReportByKey(t.db, {
        orgId: org.id,
        userId: user.id,
        apiKeyId,
        rubricId: keyRubricId,
      });

      // Simulate the bodies_and_reports scope of gdprDelete.ts:
      // deletes evaluation_reports_by_key for (userId, orgId) but NOT rubrics.
      // Key rubrics are project scoring config, not personal content — they are
      // kept on soft-erasure. The author link (createdBy) anonymizes only on
      // eventual full user hard-delete via ON DELETE SET NULL.
      await t.db
        .delete(evaluationReportsByKey)
        .where(
          and(
            eq(evaluationReportsByKey.userId, user.id),
            eq(evaluationReportsByKey.orgId, org.id),
          ),
        );

      // Key rubric must still exist after erasure.
      const remaining = await t.db
        .select({ id: rubrics.id })
        .from(rubrics)
        .where(
          and(
            eq(rubrics.id, keyRubricId),
            isNotNull(rubrics.apiKeyId),
            isNull(rubrics.deletedAt),
          ),
        );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(keyRubricId);
    },
  );
});
