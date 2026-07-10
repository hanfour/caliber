import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  rubrics,
  organizations,
  usageLogs,
  apiKeys,
  upstreamAccounts,
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
import { rubricsRouter } from "../../../src/trpc/routers/rubrics.js";

// Local sub-router: isolated from Task 6.5 appRouter wiring.
const localRouter = router({ rubrics: rubricsRouter });
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

/**
 * Minimal valid rubric definition that satisfies rubricSchema. Used in tests
 * that need a real parseable definition (create, update, dryRun).
 */
function minimalDefinition() {
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

let seedCounter = 0;

async function seedPlatformRubric(db: Database) {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId: null,
      name: `Platform Default ${seedCounter}`,
      description: "Platform-level default",
      version: "1.0.0",
      definition: minimalDefinition() as unknown as Record<string, unknown>,
      isDefault: true,
    })
    .returning({ id: rubrics.id, name: rubrics.name });
  return row!;
}

async function seedOrgRubric(
  db: Database,
  orgId: string,
  createdBy: string,
  opts: { isDefault?: boolean } = {},
) {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId,
      name: `Org Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: minimalDefinition() as unknown as Record<string, unknown>,
      isDefault: opts.isDefault ?? false,
      createdBy,
    })
    .returning({ id: rubrics.id, name: rubrics.name });
  return row!;
}

async function seedUsageLog(
  db: Database,
  opts: {
    userId: string;
    orgId: string;
    apiKeyId: string;
    accountId: string;
    totalCost?: string;
    createdAt?: Date;
  },
) {
  seedCounter += 1;
  const requestId = `req-rubric-test-${Date.now()}-${seedCounter}`;
  await db.insert(usageLogs).values({
    requestId,
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0001",
    outputCost: "0.0002",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: opts.totalCost ?? "0.0003",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    actualCostUsd: opts.totalCost ?? "0.0003",
    stream: false,
    statusCode: 200,
    durationMs: 100,
    upstreamRetries: 0,
    createdAt: opts.createdAt,
  });
  return requestId;
}

async function seedApiKey(
  db: Database,
  opts: { userId: string; orgId: string; revoked?: boolean },
) {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      teamId: null,
      keyHash: `hash-rubric-${Date.now()}-${seedCounter}`,
      keyPrefix: "ak_rb",
      name: `rubric-test-key-${seedCounter}`,
      revokedAt: opts.revoked ? new Date() : null,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedKeyRubric(
  db: Database,
  opts: { apiKeyId: string; orgId: string; createdBy: string },
) {
  seedCounter += 1;
  const [row] = await db
    .insert(rubrics)
    .values({
      orgId: opts.orgId,
      apiKeyId: opts.apiKeyId,
      name: `Key Rubric ${seedCounter}`,
      version: "1.0.0",
      definition: minimalDefinition() as unknown as Record<string, unknown>,
      isDefault: false,
      createdBy: opts.createdBy,
    })
    .returning({ id: rubrics.id });
  return row!;
}

async function seedAccount(db: Database, orgId: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `rubric-test-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("rubrics router", () => {
  // ── Test 1: list ─────────────────────────────────────────────────────────────

  it("list: returns platform defaults + org's own rubrics but not other orgs' rubrics", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const platform = await seedPlatformRubric(t.db);
    const ownRubric = await seedOrgRubric(t.db, orgA.id, admin.id);
    const otherRubric = await seedOrgRubric(t.db, orgB.id, admin.id);

    const rows = await caller.rubrics.list({ orgId: orgA.id });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(platform.id);
    expect(ids).toContain(ownRubric.id);
    expect(ids).not.toContain(otherRubric.id);
  });

  // ── Test 2: create — validation ──────────────────────────────────────────────

  it("create: rejects malformed definition and accepts valid definition", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // Malformed: missing required `sections` array
    await expect(
      caller.rubrics.create({
        orgId: org.id,
        name: "Bad Rubric",
        version: "1.0.0",
        definition: { name: "bad", version: "1.0.0" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Valid definition
    const result = await caller.rubrics.create({
      orgId: org.id,
      name: "Good Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");

    // Verify row is in the database
    const rows = await caller.rubrics.list({ orgId: org.id });
    expect(rows.some((r) => r.id === result.id)).toBe(true);
  });

  // ── Test 3: update — name + re-validate definition ───────────────────────────

  it("update: can change name and re-validate new definition", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const { id } = await caller.rubrics.create({
      orgId: org.id,
      name: "Original Name",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    // Update name only
    await caller.rubrics.update({
      rubricId: id,
      orgId: org.id,
      patch: { name: "Updated Name" },
    });

    const row = await caller.rubrics.get({ rubricId: id });
    expect(row.name).toBe("Updated Name");

    // Update with invalid definition → should reject
    await expect(
      caller.rubrics.update({
        rubricId: id,
        orgId: org.id,
        patch: { definition: { not: "a rubric" } },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Update with valid new definition → should succeed
    const newDef = { ...minimalDefinition(), version: "2.0.0" };
    await caller.rubrics.update({
      rubricId: id,
      orgId: org.id,
      patch: { version: "2.0.0", definition: newDef },
    });

    const updated = await caller.rubrics.get({ rubricId: id });
    expect(updated.version).toBe("2.0.0");
  });

  // ── Test 4: delete — rejects if org has it as active ─────────────────────────

  it("delete: rejects CONFLICT if rubric is the org's active rubric", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const { id: rubricId } = await caller.rubrics.create({
      orgId: org.id,
      name: "Active Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    // Set as active
    await caller.rubrics.setActive({ orgId: org.id, rubricId });

    // Attempting to delete the active rubric should fail
    await expect(
      caller.rubrics.delete({ rubricId, orgId: org.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // After clearing active, delete should succeed
    await caller.rubrics.setActive({ orgId: org.id, rubricId: null });
    const result = await caller.rubrics.delete({ rubricId, orgId: org.id });
    expect(result.success).toBe(true);

    // Verify it's gone from the list
    const rows = await caller.rubrics.list({ orgId: org.id });
    expect(rows.some((r) => r.id === rubricId)).toBe(false);
  });

  // ── Test 5: setActive(null) — clears org.rubric_id ───────────────────────────

  it("setActive(null): clears the org's active rubric", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const { id: rubricId } = await caller.rubrics.create({
      orgId: org.id,
      name: "Temp Active",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    await caller.rubrics.setActive({ orgId: org.id, rubricId });

    // Verify it is set
    const [before] = await t.db
      .select({ rubricId: organizations.rubricId })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1);
    expect(before?.rubricId).toBe(rubricId);

    // Clear it
    const result = await caller.rubrics.setActive({
      orgId: org.id,
      rubricId: null,
    });
    expect(result.success).toBe(true);

    const [after] = await t.db
      .select({ rubricId: organizations.rubricId })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1);
    expect(after?.rubricId).toBeNull();
  });

  // ── Test 6: setActive — allows platform default rubric ────────────────────────

  it("setActive: allows setting a platform-default rubric as active", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const platform = await seedPlatformRubric(t.db);

    const result = await caller.rubrics.setActive({
      orgId: org.id,
      rubricId: platform.id,
    });
    expect(result.success).toBe(true);

    const [row] = await t.db
      .select({ rubricId: organizations.rubricId })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1);
    expect(row?.rubricId).toBe(platform.id);
  });

  // ── Test: org procedures exclude key rubrics (org-surface leak scoping) ──────

  it("list: excludes key-scoped rubrics from the org picker", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });
    const orgRubric = await seedOrgRubric(t.db, org.id, admin.id);

    const rows = await caller.rubrics.list({ orgId: org.id });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(orgRubric.id);
    expect(ids).not.toContain(keyRubric.id);
  });

  it("get: returns NOT_FOUND for a key-scoped rubric", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });

    await expect(
      caller.rubrics.get({ rubricId: keyRubric.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("update: cannot mutate a key-scoped rubric via the org path", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });

    // update silently matches 0 rows (no CONFLICT, just a no-op)
    const result = await caller.rubrics.update({
      rubricId: keyRubric.id,
      orgId: org.id,
      patch: { name: "Should Not Update" },
    });
    expect(result.success).toBe(true);

    // Verify name was NOT changed in DB
    const [row] = await t.db
      .select({ name: rubrics.name })
      .from(rubrics)
      .where(eq(rubrics.id, keyRubric.id));
    expect(row?.name).not.toBe("Should Not Update");
  });

  it("delete: cannot soft-delete a key-scoped rubric via the org path", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });

    // delete is a no-op (matches 0 rows) — should succeed but not actually delete
    await caller.rubrics.delete({ rubricId: keyRubric.id, orgId: org.id });

    // Verify NOT soft-deleted
    const [row] = await t.db
      .select({ deletedAt: rubrics.deletedAt })
      .from(rubrics)
      .where(eq(rubrics.id, keyRubric.id));
    expect(row?.deletedAt).toBeNull();
  });

  it("dryRun: returns NOT_FOUND for a key-scoped rubric", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });

    await expect(
      caller.rubrics.dryRun({
        orgId: org.id,
        rubricId: keyRubric.id,
        userId: admin.id,
        days: 7,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("dryRun: rejects another org's rubric", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });
    const otherRubric = await seedOrgRubric(t.db, orgB.id, admin.id);

    await expect(
      caller.rubrics.dryRun({
        orgId: orgA.id,
        rubricId: otherRubric.id,
        userId: admin.id,
        days: 7,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("dryRun: rejects target users outside the org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const outsider = await makeUser(t.db);
    const caller = await callerFor({ db: t.db, userId: admin.id });
    const rubric = await seedOrgRubric(t.db, org.id, admin.id);

    await expect(
      caller.rubrics.dryRun({
        orgId: org.id,
        rubricId: rubric.id,
        userId: outsider.id,
        days: 7,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("setActive: rejects pinning a key-scoped rubric as org-active", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: admin.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: admin.id,
    });

    await expect(
      caller.rubrics.setActive({ orgId: org.id, rubricId: keyRubric.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // ── Test 7: dryRun — returns preview Report with correct shape ───────────────

  it("dryRun: returns a preview Report with the expected shape", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const { id: rubricId } = await caller.rubrics.create({
      orgId: org.id,
      name: "DryRun Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    // Seed some usage logs so there is data to score
    const apiKeyId = await seedApiKey(t.db, {
      userId: admin.id,
      orgId: org.id,
    });
    const accountId = await seedAccount(t.db, org.id);
    await seedUsageLog(t.db, {
      userId: admin.id,
      orgId: org.id,
      apiKeyId,
      accountId,
    });

    const result = await caller.rubrics.dryRun({
      orgId: org.id,
      rubricId,
      userId: admin.id,
      days: 7,
    });

    // Top-level shape
    expect(result.rubricId).toBe(rubricId);
    expect(result.userId).toBe(admin.id);
    expect(result.usageOnly).toBe(true);
    expect(result.periodStart).toBeInstanceOf(Date);
    expect(result.periodEnd).toBeInstanceOf(Date);
    expect(result.periodStart.getTime()).toBeLessThan(
      result.periodEnd.getTime(),
    );

    // Report shape
    const preview = result.preview;
    expect(typeof preview.totalScore).toBe("number");
    expect(preview.totalScore).toBeGreaterThanOrEqual(0);
    expect(preview.totalScore).toBeLessThanOrEqual(120);
    expect(Array.isArray(preview.sectionScores)).toBe(true);
    expect(preview.sectionScores.length).toBeGreaterThan(0);
    expect(preview.dataQuality).toBeDefined();
    expect(typeof preview.dataQuality.coverageRatio).toBe("number");

    // Since bodyRows = [], coverage is 0
    expect(preview.dataQuality.capturedRequests).toBe(0);
  });

  it("dryRun: scores only usage from the requested org before periodEnd", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const { id: rubricId } = await caller.rubrics.create({
      orgId: orgA.id,
      name: "DryRun Tenant Boundary Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    const apiKeyA = await seedApiKey(t.db, {
      userId: admin.id,
      orgId: orgA.id,
    });
    const accountA = await seedAccount(t.db, orgA.id);
    await seedUsageLog(t.db, {
      userId: admin.id,
      orgId: orgA.id,
      apiKeyId: apiKeyA,
      accountId: accountA,
      totalCost: "1.0000",
    });

    const apiKeyB = await seedApiKey(t.db, {
      userId: admin.id,
      orgId: orgB.id,
    });
    const accountB = await seedAccount(t.db, orgB.id);
    await seedUsageLog(t.db, {
      userId: admin.id,
      orgId: orgB.id,
      apiKeyId: apiKeyB,
      accountId: accountB,
      totalCost: "20.0000",
    });
    await seedUsageLog(t.db, {
      userId: admin.id,
      orgId: orgA.id,
      apiKeyId: apiKeyA,
      accountId: accountA,
      totalCost: "20.0000",
      createdAt: new Date(Date.now() + 60_000),
    });

    const result = await caller.rubrics.dryRun({
      orgId: orgA.id,
      rubricId,
      userId: admin.id,
      days: 7,
    });

    expect(result.preview.signalsSummary.total_cost).toBeCloseTo(1, 10);
    expect(result.preview.dataQuality.totalRequests).toBe(1);
    expect(result.preview.totalScore).toBe(100);
  });
});

// ─── Key rubric procedures: getForKey / upsertForKey / deleteForKey ───────────

describe("key rubric procedures", () => {
  // ── Happy path: owner upsert → read → delete ─────────────────────────────────

  it("owner: upsert → getForKey → deleteForKey round-trip", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    // Initially no rubric
    const empty = await caller.rubrics.getForKey({ apiKeyId: keyId });
    expect(empty).toBeNull();

    // Upsert
    const upserted = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "My Key Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });
    expect(upserted.id).toBeDefined();

    // Read back
    const got = await caller.rubrics.getForKey({ apiKeyId: keyId });
    expect(got).not.toBeNull();
    expect(got!.id).toBe(upserted.id);
    expect(got!.name).toBe("My Key Rubric");
    expect(got!.apiKeyId).toBe(keyId);
    expect(got!.orgId).toBe(org.id);
    expect(got!.isDefault).toBe(false);
    expect(got!.createdBy).toBe(owner.id);

    // Delete
    const deleted = await caller.rubrics.deleteForKey({ apiKeyId: keyId });
    expect(deleted.success).toBe(true);

    // After delete: should return null (soft-deleted)
    const afterDelete = await caller.rubrics.getForKey({ apiKeyId: keyId });
    expect(afterDelete).toBeNull();
  });

  // ── Org_admin can also read/write a key rubric ─────────────────────────────────

  it("org_admin: can upsert and read a member's key rubric", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const { id } = await adminCaller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "Admin-set Key Rubric",
      version: "1.0.0",
      definition: minimalDefinition(),
    });
    const row = await adminCaller.rubrics.getForKey({ apiKeyId: keyId });
    expect(row?.id).toBe(id);
  });

  // ── Peer member (not owner) → NOT_FOUND (anti-enumeration) ──────────────────

  it("peer member probing getForKey → NOT_FOUND (anti-enumeration)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const peer = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const peerCaller = await callerFor({ db: t.db, userId: peer.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: owner.id,
    });

    await expect(
      peerCaller.rubrics.getForKey({ apiKeyId: keyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      peerCaller.rubrics.upsertForKey({
        apiKeyId: keyId,
        name: "Peer Attempt",
        version: "1.0.0",
        definition: minimalDefinition(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      peerCaller.rubrics.deleteForKey({ apiKeyId: keyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── Cross-org admin → NOT_FOUND (anti-enumeration) ──────────────────────────

  it("cross-org admin probing getForKey → NOT_FOUND (anti-enumeration)", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const ownerA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const callerB = await callerFor({ db: t.db, userId: adminB.id });

    const keyId = await seedApiKey(t.db, { userId: ownerA.id, orgId: orgA.id });
    await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: orgA.id,
      createdBy: ownerA.id,
    });

    await expect(
      callerB.rubrics.getForKey({ apiKeyId: keyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── upsertForKey server-forces isDefault=false and orgId=key.orgId ────────────

  it("upsertForKey: server-forces isDefault=false and orgId from the key", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const { id } = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "Forced Fields Test",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    const [row] = await t.db
      .select({
        isDefault: rubrics.isDefault,
        orgId: rubrics.orgId,
        apiKeyId: rubrics.apiKeyId,
      })
      .from(rubrics)
      .where(eq(rubrics.id, id));

    expect(row?.isDefault).toBe(false);
    expect(row?.orgId).toBe(org.id);
    expect(row?.apiKeyId).toBe(keyId);
  });

  // ── upsertForKey: invalid definition → BAD_REQUEST ───────────────────────────

  it("upsertForKey: rejects malformed definition with BAD_REQUEST", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    await expect(
      caller.rubrics.upsertForKey({
        apiKeyId: keyId,
        name: "Bad Def",
        version: "1.0.0",
        definition: { not: "a rubric" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // ── upsertForKey on a revoked key → NOT_FOUND ────────────────────────────────

  it("upsertForKey on a revoked key → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const revokedKeyId = await seedApiKey(t.db, {
      userId: owner.id,
      orgId: org.id,
      revoked: true,
    });

    await expect(
      caller.rubrics.upsertForKey({
        apiKeyId: revokedKeyId,
        name: "Revoked Key Rubric",
        version: "1.0.0",
        definition: minimalDefinition(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── getForKey on a revoked key → NOT_FOUND ───────────────────────────────────

  it("getForKey on a revoked key → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const revokedKeyId = await seedApiKey(t.db, {
      userId: owner.id,
      orgId: org.id,
      revoked: true,
    });
    await seedKeyRubric(t.db, {
      apiKeyId: revokedKeyId,
      orgId: org.id,
      createdBy: owner.id,
    });

    await expect(
      caller.rubrics.getForKey({ apiKeyId: revokedKeyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── Second upsert updates the live slot (concurrent-double-create path) ───────

  it("second upsertForKey updates the existing live row (ON CONFLICT DO UPDATE)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const first = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "First Version",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    const second = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "Second Version",
      version: "2.0.0",
      definition: minimalDefinition(),
    });

    // Both upserts should refer to the same row (update, not new insert)
    expect(second.id).toBe(first.id);

    // Verify only one live row for this key
    const liveRows = await t.db
      .select({ id: rubrics.id })
      .from(rubrics)
      .where(
        and(eq(rubrics.apiKeyId, keyId), isNull(rubrics.deletedAt)),
      );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]?.id).toBe(first.id);

    const got = await caller.rubrics.getForKey({ apiKeyId: keyId });
    expect(got?.name).toBe("Second Version");
  });

  // ── Re-author after soft-delete targets the live slot ────────────────────────

  it("upsertForKey after deleteForKey creates a fresh row (soft-deleted slot freed)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    // First upsert
    const first = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "Original",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    // Soft-delete it
    await caller.rubrics.deleteForKey({ apiKeyId: keyId });

    // Re-upsert after delete: should create a new row
    const second = await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "After Re-author",
      version: "2.0.0",
      definition: minimalDefinition(),
    });

    // New row has a different id
    expect(second.id).not.toBe(first.id);

    // Only one live row
    const liveRows = await t.db
      .select({ id: rubrics.id })
      .from(rubrics)
      .where(
        and(eq(rubrics.apiKeyId, keyId), isNull(rubrics.deletedAt)),
      );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]?.id).toBe(second.id);

    const got = await caller.rubrics.getForKey({ apiKeyId: keyId });
    expect(got?.name).toBe("After Re-author");
  });

  // ── Audit rows written by upsertForKey and deleteForKey ──────────────────────

  it("upsertForKey writes a rubric.key_set audit row", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "Audit Test",
      version: "1.0.0",
      definition: minimalDefinition(),
    });

    // Import auditLogs for verification
    const { auditLogs } = await import("@caliber/db");
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, keyId));
    const keySetLog = logs.find((l) => l.action === "rubric.key_set");
    expect(keySetLog).toBeDefined();
    expect(keySetLog?.actorUserId).toBe(owner.id);
    expect(keySetLog?.targetType).toBe("api_key");
  });

  it("deleteForKey writes a rubric.key_cleared audit row", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    await caller.rubrics.upsertForKey({
      apiKeyId: keyId,
      name: "To Delete",
      version: "1.0.0",
      definition: minimalDefinition(),
    });
    await caller.rubrics.deleteForKey({ apiKeyId: keyId });

    const { auditLogs } = await import("@caliber/db");
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, keyId));
    const clearedLog = logs.find((l) => l.action === "rubric.key_cleared");
    expect(clearedLog).toBeDefined();
    expect(clearedLog?.actorUserId).toBe(owner.id);
    expect(clearedLog?.targetType).toBe("api_key");
  });

  // ── spec §6: deleteForKey allowed on a revoked key (cleanup path) ────────────

  it("deleteForKey on a revoked key by owner → succeeds (spec §6)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });

    // Seed an active key rubric, then revoke the key directly in DB.
    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: owner.id,
    });
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId));

    // deleteForKey must succeed even though the key is revoked
    const result = await caller.rubrics.deleteForKey({ apiKeyId: keyId });
    expect(result.success).toBe(true);

    // Verify soft-delete via direct DB read (getForKey returns NOT_FOUND on revoked key)
    const [row] = await t.db
      .select({ deletedAt: rubrics.deletedAt })
      .from(rubrics)
      .where(eq(rubrics.id, keyRubric.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("deleteForKey on a revoked key by org_admin → succeeds (spec §6)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({ db: t.db, userId: admin.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    const keyRubric = await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: owner.id,
    });
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId));

    const result = await adminCaller.rubrics.deleteForKey({ apiKeyId: keyId });
    expect(result.success).toBe(true);

    const [row] = await t.db
      .select({ deletedAt: rubrics.deletedAt })
      .from(rubrics)
      .where(eq(rubrics.id, keyRubric.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("deleteForKey on a revoked key by non-owner peer → NOT_FOUND (anti-enum unchanged)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const peer = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const peerCaller = await callerFor({ db: t.db, userId: peer.id });

    const keyId = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    await seedKeyRubric(t.db, {
      apiKeyId: keyId,
      orgId: org.id,
      createdBy: owner.id,
    });
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId));

    // Unauthorized caller must still get NOT_FOUND even on a revoked key
    await expect(
      peerCaller.rubrics.deleteForKey({ apiKeyId: keyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── Regression: read/author on a revoked key still → NOT_FOUND ──────────────

  it("upsertForKey on a revoked key → NOT_FOUND (regression)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const revokedKeyId = await seedApiKey(t.db, {
      userId: owner.id,
      orgId: org.id,
      revoked: true,
    });

    await expect(
      caller.rubrics.upsertForKey({
        apiKeyId: revokedKeyId,
        name: "Revoked Key Rubric",
        version: "1.0.0",
        definition: minimalDefinition(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getForKey on a revoked key → NOT_FOUND (regression)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: owner.id });
    const revokedKeyId = await seedApiKey(t.db, {
      userId: owner.id,
      orgId: org.id,
      revoked: true,
    });
    await seedKeyRubric(t.db, {
      apiKeyId: revokedKeyId,
      orgId: org.id,
      createdBy: owner.id,
    });

    await expect(
      caller.rubrics.getForKey({ apiKeyId: revokedKeyId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
