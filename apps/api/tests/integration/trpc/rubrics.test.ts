import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
  opts: { userId: string; orgId: string; apiKeyId: string; accountId: string },
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
    totalCost: "0.0003",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    stream: false,
    statusCode: 200,
    durationMs: 100,
    upstreamRetries: 0,
  });
  return requestId;
}

async function seedApiKey(
  db: Database,
  opts: { userId: string; orgId: string },
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
    })
    .returning({ id: apiKeys.id });
  return row!.id;
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
});
