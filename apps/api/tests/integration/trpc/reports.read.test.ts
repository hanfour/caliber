import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "@caliber/db";
import {
  evaluationReports,
  evaluationReportsByKey,
  apiKeys,
  rubrics,
  upstreamAccounts,
} from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeTeam,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { reportsRouter } from "../../../src/trpc/routers/reports.js";

// Local sub-router: isolated from Task 6.5 appRouter wiring.
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

function minimalRubricDefinition() {
  return {
    name: "Test Rubric",
    description: "A test rubric",
    version: "1.0.0",
    locale: "en",
    sections: [
      {
        id: "efficiency",
        name: "Efficiency",
        weight: "100%",
        standard: {
          score: 80,
          label: "Standard",
          criteria: ["Reasonable token usage"],
        },
        superior: {
          score: 100,
          label: "Superior",
          criteria: ["Excellent token usage"],
        },
        signals: [
          {
            type: "threshold",
            id: "total_cost_lte",
            metric: "total_cost",
            lte: 10.0,
          },
        ],
      },
    ],
  };
}

async function seedRubric(db: Database, orgId: string | null) {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId,
      name: `Test Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: minimalRubricDefinition() as unknown as Record<string, unknown>,
      isDefault: orgId === null,
    })
    .returning({ id: rubrics.id });
  return row!.id;
}

async function seedUpstreamAccount(db: Database, orgId: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `test-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

interface SeedReportOpts {
  orgId: string;
  userId: string;
  teamId?: string | null;
  rubricId: string;
  periodStart: Date;
  periodEnd: Date;
  llmNarrative?: string | null;
  llmEvidence?: Record<string, unknown> | null;
  llmModel?: string | null;
  llmCostUsd?: string | null;
  llmUpstreamAccountId?: string | null;
}

async function seedReport(db: Database, opts: SeedReportOpts) {
  seedCounter += 1;
  const [row] = await db
    .insert(evaluationReports)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      teamId: opts.teamId ?? null,
      rubricId: opts.rubricId,
      rubricVersion: "1.0.0",
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      periodType: "weekly",
      totalScore: "85.0000",
      sectionScores: [],
      signalsSummary: {},
      dataQuality: { coverageRatio: 0.9, capturedRequests: 0 },
      llmNarrative: opts.llmNarrative ?? null,
      llmEvidence: opts.llmEvidence ?? null,
      llmModel: opts.llmModel ?? null,
      llmCalledAt: opts.llmModel ? new Date() : null,
      llmCostUsd: opts.llmCostUsd ?? null,
      llmUpstreamAccountId: opts.llmUpstreamAccountId ?? null,
      triggeredBy: "manual",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReports.id });
  return row!.id;
}

// Seed a report with all LLM fields populated.
async function seedReportWithLlm(
  db: Database,
  opts: Omit<SeedReportOpts, "llmNarrative" | "llmEvidence" | "llmModel" | "llmCostUsd">,
) {
  return seedReport(db, {
    ...opts,
    llmNarrative: "Performance was excellent this week.",
    llmEvidence: { highlights: ["Used cache effectively"] },
    llmModel: "claude-sonnet-4-5",
    llmCostUsd: "0.0025000000",
  });
}

async function seedApiKey(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    teamId?: string | null;
    evaluateAsProject?: boolean;
    revokedAt?: Date | null;
  },
) {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      teamId: opts.teamId ?? null,
      name: `key-${seedCounter}`,
      keyHash: `hash-${seedCounter}-${Date.now()}`,
      keyPrefix: `sk-${seedCounter}`,
      evaluateAsProject: opts.evaluateAsProject ?? false,
      revokedAt: opts.revokedAt ?? null,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

interface SeedByKeyOpts {
  orgId: string;
  userId: string;
  apiKeyId: string;
  teamId?: string | null;
  rubricId: string;
  periodStart: Date;
  periodEnd: Date;
  keyNameSnapshot?: string;
  withLlm?: boolean;
}

async function seedReportByKey(db: Database, opts: SeedByKeyOpts) {
  seedCounter += 1;
  const [row] = await db
    .insert(evaluationReportsByKey)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      apiKeyId: opts.apiKeyId,
      keyNameSnapshot: opts.keyNameSnapshot ?? `snap-${seedCounter}`,
      teamId: opts.teamId ?? null,
      rubricId: opts.rubricId,
      rubricVersion: "1.0.0",
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      periodType: "daily",
      totalScore: "85.0000",
      sectionScores: [],
      signalsSummary: {},
      dataQuality: { coverageRatio: 0.9, capturedRequests: 0 },
      llmNarrative: opts.withLlm ? "By-key narrative." : null,
      llmEvidence: opts.withLlm ? { highlights: ["used cache"] } : null,
      llmModel: opts.withLlm ? "claude-sonnet-4-5" : null,
      llmCalledAt: opts.withLlm ? new Date() : null,
      llmCostUsd: opts.withLlm ? "0.0025000000" : null,
      llmUpstreamAccountId: null,
      triggeredBy: "manual",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReportsByKey.id });
  return row!.id;
}

// ─── Fixed date range used across tests ───────────────────────────────────────

const RANGE_FROM = "2025-01-01T00:00:00.000Z";
const RANGE_TO = "2025-12-31T23:59:59.999Z";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reports router — read endpoints", () => {
  // ── Test 1: getOwnLatest returns most recent report ──────────────────────────

  it("getOwnLatest: returns caller's most recent report (or null when none)", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: user.id });

    // No reports yet → null
    const empty = await caller.reports.getOwnLatest();
    expect(empty).toBeNull();

    // Seed two reports; the later one should be returned.
    await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-01-07"),
    });
    const reportId2 = await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2025-02-01"),
      periodEnd: new Date("2025-02-07"),
    });

    const latest = await caller.reports.getOwnLatest();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(reportId2);
  });

  // ── Test 2: getOwnRange returns all reports in range, sorted desc ─────────────

  it("getOwnRange: returns caller's reports in date range, ordered periodStart desc", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: user.id });

    const id1 = await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2025-03-01"),
      periodEnd: new Date("2025-03-07"),
    });
    const id2 = await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2025-04-01"),
      periodEnd: new Date("2025-04-07"),
    });
    // Outside range — should not appear
    await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2024-12-01"),
      periodEnd: new Date("2024-12-07"),
    });

    const rows = await caller.reports.getOwnRange({
      from: RANGE_FROM,
      to: RANGE_TO,
    });

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    // Verify descending order: April before March
    expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
  });

  // ── Test 3: getUser — org admin reads target user's report with LLM visible ──

  it("getUser: org_admin reads target user's reports with LLM fields visible", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const reportId = await seedReportWithLlm(t.db, {
      orgId: org.id,
      userId: member.id,
      rubricId,
      periodStart: new Date("2025-05-01"),
      periodEnd: new Date("2025-05-07"),
    });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const rows = await adminCaller.reports.getUser({
      orgId: org.id,
      userId: member.id,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(reportId);
    // org_admin → LLM fields are NOT redacted
    expect(rows[0]!.llmNarrative).not.toBeNull();
    expect(rows[0]!.llmModel).toBe("claude-sonnet-4-5");
  });

  // ── Test 4: getUser — member reads own report via getUser (self-access) ───────

  it("getUser: member can call getUser for their own userId (self-access, LLM visible)", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const member = await makeUser(t.db, { orgId: org.id });

    const reportId = await seedReportWithLlm(t.db, {
      orgId: org.id,
      userId: member.id,
      rubricId,
      periodStart: new Date("2025-06-01"),
      periodEnd: new Date("2025-06-07"),
    });

    const memberCaller = await callerFor({ db: t.db, userId: member.id });
    const rows = await memberCaller.reports.getUser({
      orgId: org.id,
      userId: member.id,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(reportId);
    // Self-access → LLM fields visible
    expect(rows[0]!.llmNarrative).not.toBeNull();
  });

  // ── Test 5: getUser — non-admin gets FORBIDDEN for another user's reports ─────

  it("getUser: non-admin gets FORBIDDEN when reading another user's reports", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const member = await makeUser(t.db, { orgId: org.id });
    const other = await makeUser(t.db, { orgId: org.id });

    await seedReport(t.db, {
      orgId: org.id,
      userId: other.id,
      rubricId,
      periodStart: new Date("2025-07-01"),
      periodEnd: new Date("2025-07-07"),
    });

    const memberCaller = await callerFor({ db: t.db, userId: member.id });
    await expect(
      memberCaller.reports.getUser({
        orgId: org.id,
        userId: other.id,
        range: { from: RANGE_FROM, to: RANGE_TO },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // ── Test 6: getTeam — team_manager sees team reports with LLM REDACTED ────────

  it("getTeam: team_manager sees team reports with LLM fields redacted", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const team = await makeTeam(t.db, org.id);
    const manager = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
      orgId: org.id,
      teamId: team.id,
    });
    const member = await makeUser(t.db, { orgId: org.id, teamId: team.id });

    await seedReportWithLlm(t.db, {
      orgId: org.id,
      userId: member.id,
      teamId: team.id,
      rubricId,
      periodStart: new Date("2025-08-01"),
      periodEnd: new Date("2025-08-07"),
    });

    const managerCaller = await callerFor({ db: t.db, userId: manager.id });
    const rows = await managerCaller.reports.getTeam({
      orgId: org.id,
      teamId: team.id,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });

    expect(rows).toHaveLength(1);
    // team_manager is NOT org_admin → LLM fields must be null
    expect(rows[0]!.llmNarrative).toBeNull();
    expect(rows[0]!.llmModel).toBeNull();
    expect(rows[0]!.llmCostUsd).toBeNull();
    expect(rows[0]!.llmEvidence).toBeNull();
    expect(rows[0]!.llmCalledAt).toBeNull();
    expect(rows[0]!.llmUpstreamAccountId).toBeNull();
    // Non-LLM fields remain visible
    expect(rows[0]!.totalScore).toBe("85.0000");
  });

  // ── Test 7: getTeam — org_admin sees team reports with LLM visible ────────────

  it("getTeam: org_admin sees team reports with LLM fields visible", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const team = await makeTeam(t.db, org.id);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id, teamId: team.id });

    const reportId = await seedReportWithLlm(t.db, {
      orgId: org.id,
      userId: member.id,
      teamId: team.id,
      rubricId,
      periodStart: new Date("2025-09-01"),
      periodEnd: new Date("2025-09-07"),
    });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const rows = await adminCaller.reports.getTeam({
      orgId: org.id,
      teamId: team.id,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });

    expect(rows.some((r) => r.id === reportId)).toBe(true);
    const report = rows.find((r) => r.id === reportId)!;
    // org_admin → LLM fields must be intact
    expect(report.llmNarrative).not.toBeNull();
    expect(report.llmModel).toBe("claude-sonnet-4-5");
    expect(report.llmCostUsd).not.toBeNull();
  });

  // ── Test 8: getOrg — org_admin sees org-wide reports unredacted ───────────────

  it("getOrg: org_admin sees org-wide reports with LLM fields unredacted", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const reportId = await seedReportWithLlm(t.db, {
      orgId: org.id,
      userId: member.id,
      rubricId,
      periodStart: new Date("2025-10-01"),
      periodEnd: new Date("2025-10-07"),
    });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const rows = await adminCaller.reports.getOrg({
      orgId: org.id,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });

    expect(rows.some((r) => r.id === reportId)).toBe(true);
    const report = rows.find((r) => r.id === reportId)!;
    expect(report.llmNarrative).toBe("Performance was excellent this week.");
    expect(report.llmModel).toBe("claude-sonnet-4-5");
  });

  // ── Test 9: getOrg — non-admin gets FORBIDDEN ────────────────────────────────

  it("getOrg: regular member gets FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });
    const memberCaller = await callerFor({ db: t.db, userId: member.id });

    await expect(
      memberCaller.reports.getOrg({
        orgId: org.id,
        range: { from: RANGE_FROM, to: RANGE_TO },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── PR5: per-key report reads ────────────────────────────────────────────────

describe("reports router — per-key read endpoints", () => {
  it("getOwnByKeyLatest: owner sees latest by-key report (full LLM); null when none", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: user.id });
    const caller = await callerFor({ db: t.db, userId: user.id });

    // None yet → null
    expect(await caller.reports.getOwnByKeyLatest({ apiKeyId })).toBeNull();

    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-01-01"),
      periodEnd: new Date("2025-01-02"),
    });
    const latestId = await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-02-01"),
      periodEnd: new Date("2025-02-02"),
      withLlm: true,
    });

    const latest = await caller.reports.getOwnByKeyLatest({ apiKeyId });
    expect(latest!.id).toBe(latestId);
    // Owner sees full LLM.
    expect(latest!.llmNarrative).toBe("By-key narrative.");
    expect(latest!.keyNameSnapshot).toBeTruthy();
  });

  it("getOwnByKeyLatest: another user's key → NOT_FOUND (anti-enumeration)", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const owner = await makeUser(t.db, { orgId: org.id });
    const other = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: owner.id });
    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-03-01"),
      periodEnd: new Date("2025-03-02"),
    });

    const otherCaller = await callerFor({ db: t.db, userId: other.id });
    await expect(
      otherCaller.reports.getOwnByKeyLatest({ apiKeyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getOwnByKeyRange: owner sees by-key reports within range, desc", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: user.id });

    const id1 = await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-04-01"),
      periodEnd: new Date("2025-04-02"),
    });
    const id2 = await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-05-01"),
      periodEnd: new Date("2025-05-02"),
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const rows = await caller.reports.getOwnByKeyRange({
      apiKeyId,
      from: RANGE_FROM,
      to: RANGE_TO,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
  });

  it("getOwnByKeyRange: another user's key → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, { orgId: org.id });
    const other = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: owner.id });

    const otherCaller = await callerFor({ db: t.db, userId: other.id });
    await expect(
      otherCaller.reports.getOwnByKeyRange({
        apiKeyId,
        from: RANGE_FROM,
        to: RANGE_TO,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getByKey: org_admin (non-subject) sees by-key reports with full LLM", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: member.id,
    });
    const reportId = await seedReportByKey(t.db, {
      orgId: org.id,
      userId: member.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-06-01"),
      periodEnd: new Date("2025-06-02"),
      withLlm: true,
    });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const rows = await adminCaller.reports.getByKey({
      orgId: org.id,
      apiKeyId,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(reportId);
    // org_admin (and subject) → LLM intact.
    expect(rows[0]!.llmNarrative).toBe("By-key narrative.");
    expect(rows[0]!.llmModel).toBe("claude-sonnet-4-5");
  });

  it("getByKey: subject (key owner) sees their own by-key reports with full LLM", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const member = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: member.id,
    });
    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: member.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-07-01"),
      periodEnd: new Date("2025-07-02"),
      withLlm: true,
    });

    const memberCaller = await callerFor({ db: t.db, userId: member.id });
    const rows = await memberCaller.reports.getByKey({
      orgId: org.id,
      apiKeyId,
      range: { from: RANGE_FROM, to: RANGE_TO },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.llmNarrative).toBe("By-key narrative.");
  });

  it("getByKey: non-subject non-admin member → FORBIDDEN (no data leak)", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const owner = await makeUser(t.db, { orgId: org.id });
    const other = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: owner.id });
    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-08-01"),
      periodEnd: new Date("2025-08-02"),
      withLlm: true,
    });

    const otherCaller = await callerFor({ db: t.db, userId: other.id });
    await expect(
      otherCaller.reports.getByKey({
        orgId: org.id,
        apiKeyId,
        range: { from: RANGE_FROM, to: RANGE_TO },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getByKey: key belongs to a different org → NOT_FOUND (anti-enumeration)", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const ownerA = await makeUser(t.db, { orgId: orgA.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: orgA.id,
      userId: ownerA.id,
    });
    await seedReportByKey(t.db, {
      orgId: orgA.id,
      userId: ownerA.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-09-01"),
      periodEnd: new Date("2025-09-02"),
    });

    // adminB asks for the key under THEIR org → key.orgId (A) !== input.orgId (B)
    const callerB = await callerFor({ db: t.db, userId: adminB.id });
    await expect(
      callerB.reports.getByKey({
        orgId: orgB.id,
        apiKeyId,
        range: { from: RANGE_FROM, to: RANGE_TO },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getByKey: unknown apiKeyId → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    await expect(
      adminCaller.reports.getByKey({
        orgId: org.id,
        apiKeyId: "00000000-0000-0000-0000-000000000000",
        range: { from: RANGE_FROM, to: RANGE_TO },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listProjectKeys: no orgId → caller's own opted-in keys with latest periodStart", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const optedIn = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
      evaluateAsProject: true,
    });
    // A non-opted key must NOT appear.
    await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
      evaluateAsProject: false,
    });
    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId: optedIn,
      rubricId,
      periodStart: new Date("2025-10-01"),
      periodEnd: new Date("2025-10-02"),
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const keys = await caller.reports.listProjectKeys({});
    expect(keys.some((k) => k.id === optedIn)).toBe(true);
    expect(keys.every((k) => k.userId === user.id)).toBe(true);
    const row = keys.find((k) => k.id === optedIn)!;
    expect(row.latestPeriodStart).not.toBeNull();
  });

  it("listProjectKeys: orgId + org_admin → all opted-in keys in org; non-admin → FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const m1 = await makeUser(t.db, { orgId: org.id });
    const m2 = await makeUser(t.db, { orgId: org.id });
    const k1 = await seedApiKey(t.db, {
      orgId: org.id,
      userId: m1.id,
      evaluateAsProject: true,
    });
    const k2 = await seedApiKey(t.db, {
      orgId: org.id,
      userId: m2.id,
      evaluateAsProject: true,
    });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const keys = await adminCaller.reports.listProjectKeys({ orgId: org.id });
    const ids = keys.map((k) => k.id);
    expect(ids).toContain(k1);
    expect(ids).toContain(k2);

    const memberCaller = await callerFor({ db: t.db, userId: m1.id });
    await expect(
      memberCaller.reports.listProjectKeys({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listProjectKeys: revoked key WITH a by-key report is returned with revokedAt set", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const user = await makeUser(t.db, { orgId: org.id });
    const revokedAt = new Date("2025-11-01T00:00:00Z");
    const revokedKey = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
      evaluateAsProject: true,
      revokedAt,
    });
    // Seed a by-key report so the key has scoring history.
    await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId: revokedKey,
      rubricId,
      periodStart: new Date("2025-10-01"),
      periodEnd: new Date("2025-10-02"),
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const keys = await caller.reports.listProjectKeys({});
    const found = keys.find((k) => k.id === revokedKey);
    // Revoked key with history MUST appear.
    expect(found).toBeDefined();
    // revokedAt must be returned so the client can mark it read-only.
    expect(found!.revokedAt).not.toBeNull();
  });

  it("listProjectKeys: revoked key WITHOUT any report is NOT returned", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });
    const revokedNoHistory = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
      evaluateAsProject: true,
      revokedAt: new Date("2025-11-01T00:00:00Z"),
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const keys = await caller.reports.listProjectKeys({});
    // Revoked key with no scoring history must be excluded.
    expect(keys.some((k) => k.id === revokedNoHistory)).toBe(false);
  });
});
