import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@caliber/db";
import {
  auditLogs,
  requestBodies,
  usageLogs,
  apiKeys,
  upstreamAccounts,
  rubrics,
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
import { contentCaptureRouter } from "../../../src/trpc/routers/contentCapture.js";

// Local sub-router so this test runs independently of Task 6.5 (which wires
// `contentCapture` into the global appRouter behind a feature flag). We test
// the router contract here without depending on appRouter assembly.
const localRouter = router({ contentCapture: contentCaptureRouter });
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

// ── Seed helpers for requestBodies ───────────────────────────────────────────
// requestBodies requires usageLogs (FK) which requires api_keys + accounts.
// We create minimal rows so the FK chain is satisfied.

let seedCounter = 0;
function uniqRequestId(): string {
  seedCounter += 1;
  return `req-cc-test-${Date.now()}-${seedCounter}`;
}

async function seedApiKey(
  db: Database,
  opts: { userId: string; orgId: string },
): Promise<string> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      teamId: null,
      keyHash: `hash-cc-${uniqRequestId()}`,
      keyPrefix: "ak_cc",
      name: `cc-test-key-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedAccount(db: Database, orgId: string): Promise<string> {
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `cc-test-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

async function seedRequestBody(
  db: Database,
  opts: { userId: string; orgId: string; apiKeyId: string; accountId: string },
): Promise<void> {
  const requestId = uniqRequestId();
  // Insert usage_log row first (FK target for request_bodies)
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

  // Insert request_body row with a future retention_until
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await db.insert(requestBodies).values({
    requestId,
    orgId: opts.orgId,
    requestBodySealed: Buffer.from("test-request"),
    responseBodySealed: Buffer.from("test-response"),
    retentionUntil: futureDate,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("contentCapture router", () => {
  it("getSettings returns defaults for a fresh org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const settings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });

    expect(settings.contentCaptureEnabled).toBe(false);
    expect(settings.contentCaptureEnabledAt).toBeNull();
    expect(settings.contentCaptureEnabledBy).toBeNull();
    expect(settings.retentionDaysOverride).toBeNull();
    expect(settings.llmEvalEnabled).toBe(false);
    expect(settings.captureThinking).toBe(false);
    expect(settings.leaderboardEnabled).toBe(false);
    // Plan 4C defaults
    expect(settings.llmFacetEnabled).toBe(false);
    expect(settings.llmFacetModel).toBeNull();
    expect(settings.llmMonthlyBudgetUsd).toBeNull();
    expect(settings.llmBudgetOverageBehavior).toBe("degrade");
    expect(settings.llmHaltedUntilMonthEnd).toBe(false);
  });

  it("setSettings persists Plan 4C cost-budget fields", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: {
        llmMonthlyBudgetUsd: 50,
        llmBudgetOverageBehavior: "halt",
      },
    });

    const settings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });
    // decimal columns return as strings from Drizzle
    expect(Number(settings.llmMonthlyBudgetUsd)).toBe(50);
    expect(settings.llmBudgetOverageBehavior).toBe("halt");
  });

  it("setSettings persists Plan 4C facet fields", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // Enable LLM eval first because facet extraction depends on it (Plan 4C
    // server-side cross-field validation rejects facet-without-eval).
    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: {
        llmEvalEnabled: true,
        llmFacetEnabled: true,
        llmFacetModel: "claude-haiku-4-5",
      },
    });

    const settings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });
    expect(settings.llmFacetEnabled).toBe(true);
    expect(settings.llmFacetModel).toBe("claude-haiku-4-5");
  });

  it("setSettings rejects facet without LLM eval (cross-field validation)", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // Org defaults to llmEvalEnabled=false. Enabling facet alone should fail.
    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        patch: {
          llmFacetEnabled: true,
          llmFacetModel: "claude-haiku-4-5",
        },
      }),
    ).rejects.toThrow(/requires LLM evaluation/i);
  });

  it("setSettings rejects facet enabled without a facet model", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        patch: {
          llmEvalEnabled: true,
          llmFacetEnabled: true,
          // model intentionally missing
        },
      }),
    ).rejects.toThrow(/facet model/i);
  });

  it("setSettings rejects invalid llmBudgetOverageBehavior via Zod", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        // @ts-expect-error — testing runtime Zod rejection
        patch: { llmBudgetOverageBehavior: "invalid" },
      }),
    ).rejects.toThrow();
  });

  it("setSettings rejects invalid llmFacetModel via Zod", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        // @ts-expect-error — testing runtime Zod rejection
        patch: { llmFacetModel: "gpt-5" },
      }),
    ).rejects.toThrow();
  });

  it("setSettings with contentCaptureEnabled: true (first-enable) writes enabledAt + enabledBy + audit log", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    const before = Date.now();
    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { contentCaptureEnabled: true },
    });
    const after = Date.now();

    // Verify org fields updated
    const settings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });
    expect(settings.contentCaptureEnabled).toBe(true);
    expect(settings.contentCaptureEnabledBy).toBe(admin.id);
    expect(settings.contentCaptureEnabledAt).not.toBeNull();
    const enabledAt = settings.contentCaptureEnabledAt!.getTime();
    expect(enabledAt).toBeGreaterThanOrEqual(before);
    expect(enabledAt).toBeLessThanOrEqual(after);

    // Verify audit log entry written
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, org.id));
    const enableLog = logs.find((l) => l.action === "content_capture.enabled");
    expect(enableLog).toBeDefined();
    expect(enableLog?.actorUserId).toBe(admin.id);
  });

  it("setSettings second call does NOT re-write enabledAt when already enabled", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // First enable
    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { contentCaptureEnabled: true },
    });
    const firstSettings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });
    const firstEnabledAt = firstSettings.contentCaptureEnabledAt;

    // Small delay to ensure timestamps would differ if re-written
    await new Promise((r) => setTimeout(r, 10));

    // Second call — already enabled
    await caller.contentCapture.setSettings({
      orgId: org.id,
      patch: { contentCaptureEnabled: true, captureThinking: true },
    });
    const secondSettings = await caller.contentCapture.getSettings({
      orgId: org.id,
    });

    // enabledAt must be unchanged
    expect(secondSettings.contentCaptureEnabledAt?.getTime()).toBe(
      firstEnabledAt?.getTime(),
    );
    // Other field should have updated
    expect(secondSettings.captureThinking).toBe(true);

    // Only one audit log entry for content_capture.enabled
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, org.id));
    const enableLogs = logs.filter(
      (l) => l.action === "content_capture.enabled",
    );
    expect(enableLogs).toHaveLength(1);
  });

  it("setSettings rejects non-org-admin with FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: member.id });

    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        patch: { contentCaptureEnabled: true },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("wipeExistingCaptures sets retention_until to now() for all rows of that org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // Seed request_body rows for this org
    const apiKeyId = await seedApiKey(t.db, {
      userId: admin.id,
      orgId: org.id,
    });
    const accountId = await seedAccount(t.db, org.id);
    await seedRequestBody(t.db, {
      userId: admin.id,
      orgId: org.id,
      apiKeyId,
      accountId,
    });
    await seedRequestBody(t.db, {
      userId: admin.id,
      orgId: org.id,
      apiKeyId,
      accountId,
    });

    const wipeBefore = new Date();
    const result = await caller.contentCapture.wipeExistingCaptures({
      orgId: org.id,
    });
    const wipeAfter = new Date();

    expect(result.success).toBe(true);

    // All rows for this org should have retention_until <= now (within test window)
    const rows = await t.db
      .select({ retentionUntil: requestBodies.retentionUntil })
      .from(requestBodies)
      .where(eq(requestBodies.orgId, org.id));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.retentionUntil.getTime()).toBeGreaterThanOrEqual(
        wipeBefore.getTime() - 1000,
      );
      expect(row.retentionUntil.getTime()).toBeLessThanOrEqual(
        wipeAfter.getTime() + 1000,
      );
    }

    // Verify audit log entry written for wipe
    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, org.id));
    const wipeLog = logs.find((l) => l.action === "content_capture.wiped");
    expect(wipeLog).toBeDefined();
    expect(wipeLog?.actorUserId).toBe(admin.id);
  });

  it("setSettings: rejects a key-scoped rubricId with FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id });

    // Seed a key and a key-scoped rubric directly in the DB
    const [keyRow] = await t.db
      .insert(apiKeys)
      .values({
        userId: admin.id,
        orgId: org.id,
        teamId: null,
        keyHash: `hash-cc-keyrubric-${Date.now()}`,
        keyPrefix: "ak_ck",
        name: "cc-key-rubric-test-key",
      })
      .returning({ id: apiKeys.id });
    const keyId = keyRow!.id;

    const [rubricRow] = await t.db
      .insert(rubrics)
      .values({
        orgId: org.id,
        apiKeyId: keyId,
        name: "Key Rubric for CC test",
        version: "1.0.0",
        definition: {
          name: "T",
          description: "d",
          version: "1.0.0",
          locale: "en",
          sections: [
            {
              id: "s1",
              name: "S1",
              weight: "100%",
              standard: { score: 80, label: "Std", criteria: ["c"] },
              superior: { score: 100, label: "Sup", criteria: ["c"] },
              signals: [
                { type: "threshold", id: "x", metric: "total_cost", lte: 10 },
              ],
            },
          ],
        } as unknown as Record<string, unknown>,
        isDefault: false,
        createdBy: admin.id,
      })
      .returning({ id: rubrics.id });
    const keyRubricId = rubricRow!.id;

    await expect(
      caller.contentCapture.setSettings({
        orgId: org.id,
        patch: { rubricId: keyRubricId },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("wipeExistingCaptures rejects non-org-admin with FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: member.id });

    await expect(
      caller.contentCapture.wipeExistingCaptures({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
