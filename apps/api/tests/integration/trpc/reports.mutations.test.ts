import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Database } from "@caliber/db";
import {
  evaluationReports,
  evaluationReportsByKey,
  gdprDeleteRequests,
  rubrics,
  upstreamAccounts,
  apiKeys,
  usageLogs,
  requestBodies,
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
import {
  reportsRouter,
  type EvaluatorQueue,
} from "../../../src/trpc/routers/reports.js";
import type { TrpcContext } from "../../../src/trpc/context.js";
import { buildEvaluatorJobId } from "@caliber/evaluator";

// Local sub-router: isolated from Task 6.5 appRouter wiring.
const localRouter = router({ reports: reportsRouter });
const createLocalCaller = createCallerFactory(localRouter);

type LocalCtx = TrpcContext & { evaluatorQueue?: EvaluatorQueue };

async function callerFor(opts: {
  db: Database;
  userId: string;
  email?: string;
  env?: ServerEnv;
  evaluatorQueue?: EvaluatorQueue;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  const ctx: LocalCtx = {
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
    evaluatorQueue: opts.evaluatorQueue,
  };
  return createLocalCaller(ctx);
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;
const EXPORT_USER_REPORT = { title: "User report", summary: "User-safe summary" };
const EXPORT_ADMIN_REPORT = { title: "Admin report", executiveSummary: "Admin-only detail" };

async function seedRubric(db: Database, orgId: string | null) {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId,
      name: `Test Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: {
        name: "r",
        description: "d",
        version: "1.0.0",
        locale: "en",
        sections: [],
      } as unknown as Record<string, unknown>,
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

async function seedApiKey(
  db: Database,
  opts: { orgId: string; userId: string },
) {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: opts.orgId,
      userId: opts.userId,
      name: `key-${seedCounter}`,
      keyHash: `hash-${seedCounter}`,
      keyPrefix: `sk-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedReport(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    rubricId: string;
    periodStart: Date;
    periodEnd: Date;
    teamId?: string | null;
  },
) {
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
      llmNarrative: "User-safe summary",
      llmUserReport: EXPORT_USER_REPORT,
      llmAdminReport: EXPORT_ADMIN_REPORT,
      llmEvidence: { quote: "admin-only evidence" },
      llmModel: "test-model",
      llmCalledAt: new Date(),
      llmCostUsd: "0.1230000000",
      llmUpstreamAccountId: null,
      triggeredBy: "manual",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReports.id });
  return row!.id;
}

async function seedReportByKey(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    apiKeyId: string;
    rubricId: string;
    periodStart: Date;
    periodEnd: Date;
  },
) {
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
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      periodType: "daily",
      totalScore: "85.0000",
      sectionScores: [],
      signalsSummary: {},
      dataQuality: { coverageRatio: 0.9, capturedRequests: 0 },
      llmNarrative: "User-safe summary",
      llmUserReport: EXPORT_USER_REPORT,
      llmAdminReport: EXPORT_ADMIN_REPORT,
      llmEvidence: { quote: "admin-only evidence" },
      llmModel: "test-model",
      llmCalledAt: new Date(),
      llmCostUsd: "0.1230000000",
      llmUpstreamAccountId: null,
      triggeredBy: "manual",
      triggeredByUser: null,
    })
    .returning({ id: evaluationReportsByKey.id });
  return row!.id;
}

async function seedUsageLogAndBody(
  db: Database,
  opts: {
    orgId: string;
    userId: string;
    apiKeyId: string;
    accountId: string;
  },
) {
  seedCounter += 1;
  const requestId = `req-${seedCounter}-${Date.now()}`;
  await db.insert(usageLogs).values({
    requestId,
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5",
    platform: "anthropic",
    surface: "api",
    inputTokens: 10,
    outputTokens: 20,
    totalCost: "0.001",
    stream: false,
    statusCode: 200,
    durationMs: 100,
  });

  const dummyBuf = Buffer.from("encrypted");
  const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await db.insert(requestBodies).values({
    requestId,
    orgId: opts.orgId,
    requestBodySealed: dummyBuf,
    responseBodySealed: dummyBuf,
    retentionUntil: futureDate,
  });

  return requestId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reports router — mutation endpoints", () => {
  // ── Test 1: rerun scope=user enqueues 1 job (test-mode fallback) ──────────────

  it("rerun scope=user returns testMode=true when no queue is wired", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const result = await adminCaller.reports.rerun({
      orgId: org.id,
      scope: "user",
      targetId: member.id,
      periodStart: "2025-01-01T00:00:00.000Z",
      periodEnd: "2025-01-07T00:00:00.000Z",
    });

    expect(result.testMode).toBe(true);
    expect(result.targets).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  // ── Test 2: rerun scope=user calls queue.add when queue is provided ───────────

  it("rerun scope=user calls evaluatorQueue.add once when queue is wired", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const mockAdd = vi.fn().mockResolvedValue({});
    const fakeQueue: EvaluatorQueue = { add: mockAdd };

    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      evaluatorQueue: fakeQueue,
    });
    const result = await adminCaller.reports.rerun({
      orgId: org.id,
      scope: "user",
      targetId: member.id,
      periodStart: "2025-02-01T00:00:00.000Z",
      periodEnd: "2025-02-07T00:00:00.000Z",
    });

    expect(result.enqueued).toBe(1);
    expect(result.targets).toBe(1);
    expect(result.testMode).toBe(false);
    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockAdd.mock.calls[0]![1]).toMatchObject({
      orgId: org.id,
      userId: member.id,
      periodStart: "2025-02-01T00:00:00.000Z",
      periodEnd: "2025-02-07T00:00:00.000Z",
      triggeredBy: "admin_rerun",
    });
  });

  // ── Test 3: rerun scope=org enqueues for all org members ──────────────────────

  it("rerun scope=org enqueues jobs for all org members when queue is wired", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const m1 = await makeUser(t.db, { orgId: org.id });
    const m2 = await makeUser(t.db, { orgId: org.id });

    const mockAdd = vi.fn().mockResolvedValue({});
    const fakeQueue: EvaluatorQueue = { add: mockAdd };

    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      evaluatorQueue: fakeQueue,
    });
    const result = await adminCaller.reports.rerun({
      orgId: org.id,
      scope: "org",
      targetId: org.id,
      periodStart: "2025-03-01T00:00:00.000Z",
      periodEnd: "2025-03-07T00:00:00.000Z",
    });

    // admin + m1 + m2 are all org members
    expect(result.targets).toBeGreaterThanOrEqual(3);
    expect(result.enqueued).toBe(result.targets);
    expect(result.testMode).toBe(false);

    const enqueuedUserIds = mockAdd.mock.calls.map(
      (c) => c[1].userId as string,
    );
    expect(enqueuedUserIds).toContain(m1.id);
    expect(enqueuedUserIds).toContain(m2.id);
  });

  // ── Test 4: rerun rejects window > 92 days ────────────────────────────────────

  it("rerun throws BAD_REQUEST when window exceeds 92 days", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    await expect(
      adminCaller.reports.rerun({
        orgId: org.id,
        scope: "user",
        targetId: member.id,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-05-15T00:00:00.000Z", // > 92 days
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Window exceeds 92 days",
    });
  });

  // ── Test 5: rerun rejects invalid period bounds ────────────────────────────────

  it("rerun throws BAD_REQUEST when periodEnd <= periodStart", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    await expect(
      adminCaller.reports.rerun({
        orgId: org.id,
        scope: "user",
        targetId: member.id,
        periodStart: "2025-06-10T00:00:00.000Z",
        periodEnd: "2025-06-05T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "periodEnd must be after periodStart",
    });
  });

  // ── PR5: rerun scope=key emits the 4-part jobId (lockstep with queue.ts) ──────

  it("rerun scope=key enqueues one job with the 4-part jobId + apiKeyId payload", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: member.id });

    const mockAdd = vi.fn().mockResolvedValue({});
    const fakeQueue: EvaluatorQueue = { add: mockAdd };

    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      evaluatorQueue: fakeQueue,
    });
    const periodStart = "2025-02-01T00:00:00.000Z";
    const result = await adminCaller.reports.rerun({
      orgId: org.id,
      scope: "key",
      apiKeyId,
      periodStart,
      periodEnd: "2025-02-07T00:00:00.000Z",
    });

    expect(result.enqueued).toBe(1);
    expect(result.targets).toBe(1);
    expect(mockAdd).toHaveBeenCalledOnce();
    // 4-part jobId via buildEvaluatorJobId (colon-free, BullMQ-safe)
    expect(mockAdd.mock.calls[0]![2]).toMatchObject({
      jobId: buildEvaluatorJobId({
        orgId: org.id,
        userId: member.id,
        apiKeyId,
        periodStart,
        periodType: "daily",
      }),
    });
    // payload carries apiKeyId + keyNameSnapshot for per-key grain
    expect(mockAdd.mock.calls[0]![1]).toMatchObject({
      orgId: org.id,
      userId: member.id,
      apiKeyId,
      triggeredBy: "admin_rerun",
    });
    expect(mockAdd.mock.calls[0]![1].keyNameSnapshot).toBeTruthy();
  });

  it("rerun scope=key respects the ≤92-day window guard (BAD_REQUEST)", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: org.id, userId: member.id });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    await expect(
      adminCaller.reports.rerun({
        orgId: org.id,
        scope: "key",
        apiKeyId,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-05-15T00:00:00.000Z", // > 92 days
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Window exceeds 92 days" });
  });

  it("rerun scope=key for a key in another org → NOT_FOUND (anti-enumeration)", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const ownerA = await makeUser(t.db, { orgId: orgA.id });
    const apiKeyId = await seedApiKey(t.db, { orgId: orgA.id, userId: ownerA.id });

    const callerB = await callerFor({ db: t.db, userId: adminB.id });
    await expect(
      callerB.reports.rerun({
        orgId: orgB.id,
        scope: "key",
        apiKeyId,
        periodStart: "2025-03-01T00:00:00.000Z",
        periodEnd: "2025-03-07T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── Window cap: 92 days (one quarter) ────────────────────────────────────────

  it("rerun accepts a 90-day window (within the 92-day cap)", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const mockAdd = vi.fn().mockResolvedValue({});
    const fakeQueue: EvaluatorQueue = { add: mockAdd };

    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      evaluatorQueue: fakeQueue,
    });
    const result = await adminCaller.reports.rerun({
      orgId: org.id,
      scope: "user",
      targetId: member.id,
      periodStart: "2025-04-01T00:00:00.000Z",
      periodEnd: "2025-06-30T00:00:00.000Z", // 90 days
    });

    expect(result.enqueued).toBe(1);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it("rerun rejects a window longer than 92 days", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    await expect(
      adminCaller.reports.rerun({
        orgId: org.id,
        scope: "user",
        targetId: member.id,
        periodStart: "2025-01-01T00:00:00.000Z",
        periodEnd: "2025-04-15T00:00:00.000Z", // 104 days
      }),
    ).rejects.toThrow(/Window exceeds 92 days/);
  });

  // ── Test 6: exportOwn returns reports + body metadata (no decrypted content) ──

  it("exportOwn returns reports and body listing without decrypted content", async () => {
    const org = await makeOrg(t.db);
    const rubricId = await seedRubric(t.db, null);
    const accountId = await seedUpstreamAccount(t.db, org.id);
    const user = await makeUser(t.db, { orgId: org.id });
    const apiKeyId = await seedApiKey(t.db, {
      orgId: org.id,
      userId: user.id,
    });

    await seedReport(t.db, {
      orgId: org.id,
      userId: user.id,
      rubricId,
      periodStart: new Date("2025-04-01"),
      periodEnd: new Date("2025-04-07"),
    });

    // GDPR access/portability: the caller's per-key reports must be included.
    const byKeyId = await seedReportByKey(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      rubricId,
      periodStart: new Date("2025-04-01"),
      periodEnd: new Date("2025-04-02"),
    });

    const requestId = await seedUsageLogAndBody(t.db, {
      orgId: org.id,
      userId: user.id,
      apiKeyId,
      accountId,
    });

    const userCaller = await callerFor({ db: t.db, userId: user.id });
    const result = await userCaller.reports.exportOwn();

    expect(result.userId).toBe(user.id);
    expect(result.exportedAt).toBeInstanceOf(Date);
    expect(result.reports).toHaveLength(1);
    expect(result.reportsByKey).toHaveLength(1);
    expect(result.reportsByKey[0]!.id).toBe(byKeyId);
    for (const report of [...result.reports, ...result.reportsByKey]) {
      expect(report.reportAudience).toBe("user");
      expect(report.generatedReport).toEqual(EXPORT_USER_REPORT);
      expect(report.llmUserReport).toBeNull();
      expect(report.llmAdminReport).toBeNull();
      expect(report.llmEvidence).toBeNull();
      expect(report.llmCostUsd).toBeNull();
    }
    expect(result.bodies.length).toBeGreaterThanOrEqual(1);

    const body = result.bodies.find((b) => b.requestId === requestId);
    expect(body).toBeDefined();
    expect(body!.requestId).toBe(requestId);
    expect(body!.capturedAt).toBeInstanceOf(Date);
    // Sealed/encrypted fields must NOT be present in the export
    expect(
      (body as Record<string, unknown>)["requestBodySealed"],
    ).toBeUndefined();
    expect(
      (body as Record<string, unknown>)["responseBodySealed"],
    ).toBeUndefined();
    expect(result.note).toContain("encrypted at rest");
  });

  // ── Test 7: deleteOwn inserts a pending gdpr_delete_requests row ──────────────

  it("deleteOwn inserts a pending GDPR delete request row", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, { orgId: org.id });

    const userCaller = await callerFor({ db: t.db, userId: user.id });
    const result = await userCaller.reports.deleteOwn({
      orgId: org.id,
      scope: "bodies",
      reason: "I want my data removed",
    });

    expect(result.id).toBeTruthy();

    // Verify the DB row was actually inserted and is pending (no approvedAt/rejectedAt)
    const rows = await t.db.select().from(gdprDeleteRequests);
    const inserted = rows.find((r) => r.id === result.id);
    expect(inserted).toBeDefined();
    expect(inserted!.userId).toBe(user.id);
    expect(inserted!.orgId).toBe(org.id);
    expect(inserted!.scope).toBe("bodies");
    expect(inserted!.reason).toBe("I want my data removed");
    expect(inserted!.approvedAt).toBeNull();
    expect(inserted!.rejectedAt).toBeNull();
    expect(inserted!.requestedByUserId).toBe(user.id);
  });

  // ── Test 8: approveDelete sets approvedAt + approvedByUserId ─────────────────

  it("approveDelete sets approvedAt and approvedByUserId on the request", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    // Member submits a delete request
    const memberCaller = await callerFor({ db: t.db, userId: member.id });
    const { id: requestId } = await memberCaller.reports.deleteOwn({
      orgId: org.id,
      scope: "bodies_and_reports",
    });

    // Admin approves it
    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const approveResult = await adminCaller.reports.approveDelete({
      orgId: org.id,
      requestId,
    });

    expect(approveResult.success).toBe(true);

    const rows = await t.db.select().from(gdprDeleteRequests);
    const updated = rows.find((r) => r.id === requestId);
    expect(updated).toBeDefined();
    expect(updated!.approvedAt).toBeInstanceOf(Date);
    expect(updated!.approvedByUserId).toBe(admin.id);
    expect(updated!.rejectedAt).toBeNull();
  });

  // ── Test 9: rejectDelete sets rejectedAt + rejectedReason ────────────────────

  it("rejectDelete sets rejectedAt and rejectedReason on the request", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    // Member submits a delete request
    const memberCaller = await callerFor({ db: t.db, userId: member.id });
    const { id: requestId } = await memberCaller.reports.deleteOwn({
      orgId: org.id,
      scope: "bodies",
      reason: "Personal data removal request",
    });

    // Admin rejects it with a reason
    const adminCaller = await callerFor({ db: t.db, userId: admin.id });
    const rejectResult = await adminCaller.reports.rejectDelete({
      orgId: org.id,
      requestId,
      reason: "Retention policy requires 90-day hold",
    });

    expect(rejectResult.success).toBe(true);

    const rows = await t.db.select().from(gdprDeleteRequests);
    const updated = rows.find((r) => r.id === requestId);
    expect(updated).toBeDefined();
    expect(updated!.rejectedAt).toBeInstanceOf(Date);
    expect(updated!.rejectedReason).toBe(
      "Retention policy requires 90-day hold",
    );
    expect(updated!.approvedAt).toBeNull();
  });
});
