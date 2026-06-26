import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "@caliber/db";
import { apiKeys, upstreamAccounts, usageLogs, modelPricing } from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  makeTeam,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { usageRouter } from "../../../src/trpc/routers/usage.js";

// Local sub-router so this test runs independently of Task 8.4 (which wires
// `usage` into the global appRouter). Strictly typed against the real router.
const localRouter = router({ usage: usageRouter });
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

// ── Helpers for seeding usage_logs ───────────────────────────────────────────
//
// `usage_logs` has FKs into api_keys + upstream_accounts. Tests that aggregate
// over usage need a real api_key + account row to satisfy the FK; we don't
// care about the key material, just the IDs.

let seedCounter = 0;
function uniqRequestId(): string {
  seedCounter += 1;
  return `req-usage-test-${Date.now()}-${seedCounter}`;
}

async function seedApiKey(
  db: Database,
  opts: { userId: string; orgId: string; teamId?: string | null },
): Promise<string> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      teamId: opts.teamId ?? null,
      // FK target rows in api_keys require a unique keyHash; generate per call.
      keyHash: `hash-${uniqRequestId()}`,
      keyPrefix: "ak_test",
      name: `usage-test-key-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedAccount(db: Database, orgId: string): Promise<string> {
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `usage-test-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

interface SeedRow {
  userId: string;
  apiKeyId: string;
  accountId: string;
  orgId: string;
  teamId?: string | null;
  requestedModel?: string;
  upstreamModel?: string;
  totalCost?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  statusCode?: number;
  createdAt?: Date;
}

async function insertUsageRow(db: Database, opts: SeedRow) {
  const requestedModel = opts.requestedModel ?? "claude-sonnet-4-5";
  await db.insert(usageLogs).values({
    requestId: uniqRequestId(),
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    teamId: opts.teamId ?? null,
    requestedModel,
    upstreamModel: opts.upstreamModel ?? `${requestedModel}-20250101`,
    platform: "anthropic",
    surface: "messages",
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 200,
    cacheCreationTokens: opts.cacheCreationTokens ?? 0,
    cacheReadTokens: opts.cacheReadTokens ?? 0,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: opts.totalCost ?? "0.0030000000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    stream: false,
    statusCode: opts.statusCode ?? 200,
    durationMs: 1234,
    upstreamRetries: 0,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

describe("usage router", () => {
  it("summary: scope=own returns only the caller's totals", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const b = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const aKey = await seedApiKey(t.db, { userId: a.id, orgId: org.id });
    const bKey = await seedApiKey(t.db, { userId: b.id, orgId: org.id });

    // Two rows for A, one for B. Scope=own from A's caller must ignore B's.
    await insertUsageRow(t.db, {
      userId: a.id,
      apiKeyId: aKey,
      accountId: account,
      orgId: org.id,
      totalCost: "0.5000000000",
      inputTokens: 10,
      outputTokens: 20,
    });
    await insertUsageRow(t.db, {
      userId: a.id,
      apiKeyId: aKey,
      accountId: account,
      orgId: org.id,
      totalCost: "0.2500000000",
      inputTokens: 5,
      outputTokens: 7,
    });
    await insertUsageRow(t.db, {
      userId: b.id,
      apiKeyId: bKey,
      accountId: account,
      orgId: org.id,
      totalCost: "9.9999999999",
      inputTokens: 999,
      outputTokens: 999,
    });

    const callerA = await callerFor({ db: t.db, userId: a.id });
    const summary = await callerA.usage.summary({ scope: { type: "own" } });

    expect(summary.totalRequests).toBe(2);
    // Decimal preserved as a string with full scale (numeric(20, 10)).
    // Asserting the EXACT serialized value pins down the precision contract:
    // a regression that cast to ::float8::text would yield "0.75" and break
    // bigdecimal rendering downstream — `toBeCloseTo(0.75)` would still pass.
    expect(summary.totalCostUsd).toBe("0.7500000000");
    expect(summary.totalInputTokens).toBe(15);
    expect(summary.totalOutputTokens).toBe(27);
  });

  it("summary: scope=org with org_admin returns full org totals", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const adminKey = await seedApiKey(t.db, {
      userId: admin.id,
      orgId: org.id,
    });
    const memberKey = await seedApiKey(t.db, {
      userId: member.id,
      orgId: org.id,
    });
    await insertUsageRow(t.db, {
      userId: admin.id,
      apiKeyId: adminKey,
      accountId: account,
      orgId: org.id,
      totalCost: "1.0000000000",
    });
    await insertUsageRow(t.db, {
      userId: member.id,
      apiKeyId: memberKey,
      accountId: account,
      orgId: org.id,
      totalCost: "2.0000000000",
    });

    const caller = await callerFor({ db: t.db, userId: admin.id });
    const summary = await caller.usage.summary({
      scope: { type: "org", orgId: org.id },
    });
    expect(summary.totalRequests).toBe(2);
    expect(Number(summary.totalCostUsd)).toBeCloseTo(3.0, 8);
  });

  it("summary: cross-org caller is FORBIDDEN at scope=org", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    // adminB has no role in orgA, so reading orgA's usage must be denied.
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminB.id });
    await expect(
      caller.usage.summary({ scope: { type: "org", orgId: orgA.id } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("summary: scope=team is FORBIDDEN for an org member who is not on the team and not a team_manager", async () => {
    // RBAC: usage.read_team requires team_manager on the target team OR
    // org_admin on the parent org. A plain org member (even one who happens
    // to be in the same org) must not be able to read another team's usage.
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const outsider = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: outsider.id });
    await expect(
      caller.usage.summary({
        scope: { type: "team", teamId: team.id, orgId: org.id },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("summary: scope=user is FORBIDDEN when caller is neither org_admin nor the target user", async () => {
    // RBAC: usage.read_user allows the target user themselves OR an
    // org_admin on the parent org. A peer member trying to read another
    // user's usage must be denied even within the same org.
    const org = await makeOrg(t.db);
    const peer = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: peer.id });
    await expect(
      caller.usage.summary({
        scope: { type: "user", userId: target.id, orgId: org.id },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("list: cross-org caller is FORBIDDEN at scope=org (verifies list shares the same RBAC guard)", async () => {
    // The `list` procedure must enforce the SAME ensureCanReadScope check as
    // `summary`. Without this test, a regression that drops the guard from
    // `list` (or wires the wrong action) would leak rows across orgs.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminB.id });
    await expect(
      caller.usage.list({ scope: { type: "org", orgId: orgA.id } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("summary: scope=team allows team_manager", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const manager = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
      orgId: org.id,
      teamId: team.id,
    });
    const teammate = await makeUser(t.db, {
      role: "member",
      scopeType: "team",
      scopeId: team.id,
      orgId: org.id,
      teamId: team.id,
    });
    const account = await seedAccount(t.db, org.id);
    const teammateKey = await seedApiKey(t.db, {
      userId: teammate.id,
      orgId: org.id,
      teamId: team.id,
    });
    // Two rows on the team, plus an unrelated row outside the team that must
    // be excluded from the team-scoped totals.
    await insertUsageRow(t.db, {
      userId: teammate.id,
      apiKeyId: teammateKey,
      accountId: account,
      orgId: org.id,
      teamId: team.id,
      totalCost: "1.5000000000",
    });
    await insertUsageRow(t.db, {
      userId: teammate.id,
      apiKeyId: teammateKey,
      accountId: account,
      orgId: org.id,
      teamId: team.id,
      totalCost: "0.5000000000",
    });
    // Same teammate / org but no teamId → must NOT count toward team scope.
    await insertUsageRow(t.db, {
      userId: teammate.id,
      apiKeyId: teammateKey,
      accountId: account,
      orgId: org.id,
      teamId: null,
      totalCost: "99.0000000000",
    });

    const caller = await callerFor({ db: t.db, userId: manager.id });
    const summary = await caller.usage.summary({
      scope: { type: "team", teamId: team.id, orgId: org.id },
    });
    expect(summary.totalRequests).toBe(2);
    expect(Number(summary.totalCostUsd)).toBeCloseTo(2.0, 8);
  });

  it("summary: scope=user lets org_admin read a specific user's totals", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const targetKey = await seedApiKey(t.db, {
      userId: target.id,
      orgId: org.id,
    });
    await insertUsageRow(t.db, {
      userId: target.id,
      apiKeyId: targetKey,
      accountId: account,
      orgId: org.id,
      totalCost: "0.4200000000",
    });

    const caller = await callerFor({ db: t.db, userId: admin.id });
    const summary = await caller.usage.summary({
      scope: { type: "user", userId: target.id, orgId: org.id },
    });
    expect(summary.totalRequests).toBe(1);
    expect(Number(summary.totalCostUsd)).toBeCloseTo(0.42, 8);
  });

  it("summary: from/to filters out older rows", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: user.id, orgId: org.id });

    const oldDate = new Date("2024-01-01T00:00:00Z");
    const newDate = new Date("2026-04-15T00:00:00Z");
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      totalCost: "10.0000000000",
      createdAt: oldDate,
    });
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      totalCost: "1.0000000000",
      createdAt: newDate,
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const summary = await caller.usage.summary({
      scope: { type: "own" },
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
    });
    expect(summary.totalRequests).toBe(1);
    expect(Number(summary.totalCostUsd)).toBeCloseTo(1.0, 8);
  });

  it("summary: byModel groups by requested_model and orders by cost desc", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: user.id, orgId: org.id });
    // Two requests of opus (cheaper), three of sonnet (pricier total).
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      requestedModel: "claude-opus-4-5",
      totalCost: "0.1000000000",
    });
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      requestedModel: "claude-opus-4-5",
      totalCost: "0.1000000000",
    });
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      requestedModel: "claude-sonnet-4-5",
      totalCost: "1.0000000000",
    });
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      requestedModel: "claude-sonnet-4-5",
      totalCost: "1.0000000000",
    });
    await insertUsageRow(t.db, {
      userId: user.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      requestedModel: "claude-sonnet-4-5",
      totalCost: "1.0000000000",
    });

    const caller = await callerFor({ db: t.db, userId: user.id });
    const summary = await caller.usage.summary({ scope: { type: "own" } });
    expect(summary.byModel).toHaveLength(2);
    // Sonnet first (higher cost sum).
    expect(summary.byModel[0]!.model).toBe("claude-sonnet-4-5");
    expect(summary.byModel[0]!.requests).toBe(3);
    // Pin the EXACT decimal string — same contract as totalCostUsd. Sum of
    // three "1.0000000000" rows must serialize as "3.0000000000", not "3".
    expect(summary.byModel[0]!.costUsd).toBe("3.0000000000");
    expect(summary.byModel[1]!.model).toBe("claude-opus-4-5");
    expect(summary.byModel[1]!.requests).toBe(2);
    expect(Number(summary.byModel[1]!.costUsd)).toBeCloseTo(0.2, 8);
  });

  it("list: scope=own returns at most pageSize, ordered DESC, with accurate totalCount", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: user.id, orgId: org.id });

    // Insert 7 rows with explicit increasing-but-past timestamps so DESC
    // ordering is deterministic AND every row falls inside the default
    // `to` window (= now). Using `Date.now() + N` would push rows into the
    // future relative to the default upper bound and they'd be filtered out.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 7; i += 1) {
      await insertUsageRow(t.db, {
        userId: user.id,
        apiKeyId: key,
        accountId: account,
        orgId: org.id,
        totalCost: `0.00${i}0000000`,
        createdAt: new Date(base + i * 1000),
      });
    }

    const caller = await callerFor({ db: t.db, userId: user.id });
    const page = await caller.usage.list({
      scope: { type: "own" },
      page: 1,
      pageSize: 5,
    });
    expect(page.items).toHaveLength(5);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(5);
    expect(page.totalCount).toBe(7);

    // DESC by createdAt: each subsequent createdAt should be <= the prior.
    for (let i = 1; i < page.items.length; i += 1) {
      const prev = page.items[i - 1]!.createdAt as unknown as Date;
      const curr = page.items[i]!.createdAt as unknown as Date;
      expect(prev.getTime()).toBeGreaterThanOrEqual(curr.getTime());
    }

    // Drill-down columns surfaced; PII columns intentionally absent.
    const sample = page.items[0]!;
    expect(sample).toHaveProperty("requestId");
    expect(sample).toHaveProperty("totalCost");
    expect(sample).toHaveProperty("statusCode");
    expect(sample).not.toHaveProperty("userAgent");
    expect(sample).not.toHaveProperty("ipAddress");
    expect(sample).not.toHaveProperty("failedAccountIds");
  });

  it("list: page 2 returns the remaining rows", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: user.id, orgId: org.id });

    // Past timestamps so they all fall inside the default `to`=now window.
    const base = Date.now() - 60_000;
    for (let i = 0; i < 6; i += 1) {
      await insertUsageRow(t.db, {
        userId: user.id,
        apiKeyId: key,
        accountId: account,
        orgId: org.id,
        createdAt: new Date(base + i * 1000),
      });
    }

    const caller = await callerFor({ db: t.db, userId: user.id });
    const page2 = await caller.usage.list({
      scope: { type: "own" },
      page: 2,
      pageSize: 4,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.totalCount).toBe(6);
  });

  it("ENABLE_GATEWAY=false → NOT_FOUND for both summary and list", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({
      db: t.db,
      userId: user.id,
      env: { ...defaultTestEnv, ENABLE_GATEWAY: false },
    });
    await expect(
      caller.usage.summary({ scope: { type: "own" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.usage.list({ scope: { type: "own" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("summary: empty window returns zeroed totals (decimals as '0' strings)", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id });
    const summary = await caller.usage.summary({ scope: { type: "own" } });
    expect(summary.totalRequests).toBe(0);
    // Decimal preserved as a string (not coerced to number) — UI relies on
    // exact string for bigdecimal rendering.
    expect(typeof summary.totalCostUsd).toBe("string");
    expect(Number(summary.totalCostUsd)).toBe(0);
    expect(summary.byModel).toEqual([]);
  });

  it("list: pageSize cap rejects values above 200", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id });
    await expect(
      caller.usage.list({ scope: { type: "own" }, pageSize: 201 }),
    ).rejects.toThrow();
  });

  // Self-contained pricing for a UNIQUE test model so the notional cost is
  // deterministic + can't collide with the seeded snapshot. $3/M in, $15/M out.
  async function seedTestModelPricing(modelId: string): Promise<void> {
    await t.db.insert(modelPricing).values({
      platform: "anthropic",
      modelId,
      inputPerMillionMicros: 3_000_000n,
      outputPerMillionMicros: 15_000_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cachedInputPerMillionMicros: null,
      cacheReadPerMillionMicros: null,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    });
  }

  // REGRESSION GUARD for the v0.16.8 500: the byKey `notionalCostUsd` SQL had an
  // unbalanced paren (typecheck can't see SQL-string syntax). This test EXECUTES
  // the query against real postgres, so a paren/syntax error fails it.
  it("summary.byKey: per-key breakdown with a notional cost from current pricing", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: u.id, orgId: org.id });
    await seedTestModelPricing("test-bykey-model");

    // 1M input + 1M output → 1M*3M + 1M*15M = 1.8e13 micros; /1e12 = $18.
    await insertUsageRow(t.db, {
      userId: u.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      upstreamModel: "test-bykey-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalCost: "0.0000000000",
    });

    const caller = await callerFor({ db: t.db, userId: u.id });
    const summary = await caller.usage.summary({ scope: { type: "own" } });

    expect(summary.byKey).toHaveLength(1);
    const row = summary.byKey[0]!;
    expect(row.apiKeyId).toBe(key);
    expect(row.requests).toBe(1);
    expect(row.inputTokens).toBe(1_000_000);
    expect(row.outputTokens).toBe(1_000_000);
    expect(Number(row.notionalCostUsd)).toBeCloseTo(18, 4);
    expect(Number(row.costUsd)).toBe(0); // actual cost stays $0 (subscription)
  });

  // REGRESSION GUARD for the per-row notional cost in usage.list (v0.16.9).
  it("list: each row carries a per-row notional cost", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: u.id, orgId: org.id });
    await seedTestModelPricing("test-list-model");

    await insertUsageRow(t.db, {
      userId: u.id,
      apiKeyId: key,
      accountId: account,
      orgId: org.id,
      upstreamModel: "test-list-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    const caller = await callerFor({ db: t.db, userId: u.id });
    const page = await caller.usage.list({
      scope: { type: "own" },
      page: 1,
      pageSize: 10,
    });

    expect(page.items).toHaveLength(1);
    expect(Number(page.items[0]!.notionalCost)).toBeCloseTo(18, 4);
  });
});

describe("usage.errorSummary", () => {
  it("counts 4xx/429/5xx for the caller and ignores other users", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const b = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const account = await seedAccount(t.db, org.id);
    const aKey = await seedApiKey(t.db, { userId: a.id, orgId: org.id });
    const bKey = await seedApiKey(t.db, { userId: b.id, orgId: org.id });

    // A: 200, 200, 429, 500, 403 → total 5, errors 3 (429+500+403), 429×1, 5xx×1
    for (const code of [200, 200, 429, 500, 403]) {
      await insertUsageRow(t.db, { userId: a.id, apiKeyId: aKey, accountId: account, orgId: org.id, statusCode: code });
    }
    // B: a 500 that must NOT be counted for A
    await insertUsageRow(t.db, { userId: b.id, apiKeyId: bKey, accountId: account, orgId: org.id, statusCode: 500 });

    const callerA = await callerFor({ db: t.db, userId: a.id });
    const res = await callerA.usage.errorSummary({ scope: { type: "own" } });

    expect(res.totalRequests).toBe(5);
    expect(res.errorRequests).toBe(3);
    expect(res.count429).toBe(1);
    expect(res.count5xx).toBe(1);
  });

  it("returns all-zero for an empty window", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id });
    const res = await caller.usage.errorSummary({ scope: { type: "own" } });
    expect(res).toEqual({ totalRequests: 0, errorRequests: 0, count429: 0, count5xx: 0 });
  });

  it("excludes rows outside the default 30-day window", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: u.id, orgId: org.id });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40d ago; default window is 30d
    await insertUsageRow(t.db, { userId: u.id, apiKeyId: key, accountId: account, orgId: org.id, statusCode: 500, createdAt: old });
    const caller = await callerFor({ db: t.db, userId: u.id });
    const res = await caller.usage.errorSummary({ scope: { type: "own" } });
    expect(res.totalRequests).toBe(0);
  });

  it("throws NOT_FOUND when the gateway is disabled", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, env: { ...defaultTestEnv, ENABLE_GATEWAY: false } });
    await expect(caller.usage.errorSummary({ scope: { type: "own" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
