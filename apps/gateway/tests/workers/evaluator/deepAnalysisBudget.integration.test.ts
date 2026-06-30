/**
 * Integration tests for the deep-analysis budget gate + ledger writer
 * (Per-project scoring PR2 — closes the spend-blind gap).
 *
 * Real Postgres testcontainer (so migration 0022's `llm_usage_dedup_idx`
 * partial unique index exists — the writer's `onConflictDoNothing` targets it).
 *
 * Cases (per Task 2 brief, step 3):
 *   (a) org over budget → deepAnalysisBudgetGate({enforce:true}) → { skip: true }
 *   (b) a deep-analysis success writes exactly ONE llm_usage_events row
 *       (event_type=deep_analysis, tokens NOT NULL recovered, cost>0)
 *   (c) writeDeepAnalysisLedger twice with same reportId → only ONE row (dedup)
 *   (d) enforce:false → gate never skips, but the writer still ledgers
 *   (+) under-budget → { skip: false }; recovered tokens raise getMonthSpend
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import {
  organizations,
  users,
  apiKeys,
  upstreamAccounts,
  usageLogs,
  llmUsageEvents,
  type Database,
} from "@caliber/db";
import { createBudgetDeps } from "../../../src/workers/evaluator/budgetDeps.js";
import {
  deepAnalysisBudgetGate,
  writeDeepAnalysisLedger,
  DEEP_ANALYSIS_EVENT_TYPE,
  REF_TYPE_PERSON,
  REF_TYPE_KEY,
} from "../../../src/workers/evaluator/ledgerDeepAnalysis.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

const STUB_LLM_MODEL = "claude-haiku-4-5";

const noopSleep = async (_ms: number): Promise<void> => {};

async function seedUsageLog(
  reqId: string,
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: string;
    requestedModel?: string;
  } = {},
): Promise<void> {
  await db.insert(usageLogs).values({
    requestId: reqId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: opts.requestedModel ?? STUB_LLM_MODEL,
    upstreamModel: STUB_LLM_MODEL,
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: opts.inputTokens ?? 1234,
    outputTokens: opts.outputTokens ?? 567,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0040000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: opts.totalCost ?? "0.0123456789",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 800,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
  });
}

/** Seed a settled spend row for the *current* month (so getMonthSpend counts it). */
async function seedSpend(costUsd: string): Promise<void> {
  await db.insert(llmUsageEvents).values({
    orgId,
    eventType: "facet_extraction",
    model: STUB_LLM_MODEL,
    tokensInput: 10,
    tokensOutput: 10,
    costUsd,
    refType: null,
    refId: null,
  });
}

async function setBudget(
  budgetUsd: string | null,
  behavior: "degrade" | "halt" = "degrade",
): Promise<void> {
  await db
    .update(organizations)
    .set({
      llmMonthlyBudgetUsd: budgetUsd,
      llmBudgetOverageBehavior: behavior,
      llmHaltedUntilMonthEnd: false,
      llmHaltedAt: null,
    })
    .where(eq(organizations.id, orgId));
}

function randomUuid(): string {
  return crypto.randomUUID();
}

async function countLedger(reportId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(llmUsageEvents)
    .where(eq(llmUsageEvents.refId, reportId));
  return rows[0]!.n;
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "deep-analysis-budget-org",
      name: "Deep Analysis Budget Org",
      llmEvalEnabled: true,
      llmEvalModel: STUB_LLM_MODEL,
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "deep-analysis-budget@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "deep-budget-upstream",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;

  const [key] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-deep-budget-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "db-test",
      name: "deep-budget-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  apiKeyId = key!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE llm_usage_events RESTART IDENTITY CASCADE`);
  await setBudget(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("deepAnalysisBudgetGate", () => {
  it("(a) org over budget + enforce:true → skip:true", async () => {
    await setBudget("0.50");
    await seedSpend("0.75"); // month-to-date 0.75 > 0.50 budget

    const result = await deepAnalysisBudgetGate({
      db,
      orgId,
      enforce: true,
    });

    expect(result.skip).toBe(true);
  });

  it("under budget + enforce:true → skip:false", async () => {
    await setBudget("100.00");
    await seedSpend("0.25");

    const result = await deepAnalysisBudgetGate({
      db,
      orgId,
      enforce: true,
    });

    expect(result.skip).toBe(false);
  });

  it("unlimited budget (NULL) + enforce:true → skip:false", async () => {
    await setBudget(null);
    await seedSpend("999.99");

    const result = await deepAnalysisBudgetGate({
      db,
      orgId,
      enforce: true,
    });

    expect(result.skip).toBe(false);
  });

  it("(d) over budget but enforce:false → skip:false (kill-switch disables enforcement)", async () => {
    await setBudget("0.50");
    await seedSpend("0.75");

    const result = await deepAnalysisBudgetGate({
      db,
      orgId,
      enforce: false,
    });

    expect(result.skip).toBe(false);
  });
});

describe("writeDeepAnalysisLedger", () => {
  it("(b) deep-analysis success writes exactly ONE row with recovered tokens + cost>0", async () => {
    const reqId = "req-deep-ledger-001";
    const reportId = randomUuid();
    await seedUsageLog(reqId, {
      inputTokens: 1234,
      outputTokens: 567,
      totalCost: "0.0123456789",
    });

    const res = await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: reqId,
      sleepMs: noopSleep,
    });

    expect(res.written).toBe(true);
    expect(res.tokensInput).toBe(1234);
    expect(res.tokensOutput).toBe(567);
    expect(res.costUsd).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.refId, reportId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventType).toBe(DEEP_ANALYSIS_EVENT_TYPE);
    expect(row.refType).toBe(REF_TYPE_PERSON);
    expect(row.orgId).toBe(orgId);
    // NOT-NULL columns recovered from the loopback usage_log (no placeholder)
    expect(row.tokensInput).toBe(1234);
    expect(row.tokensOutput).toBe(567);
    expect(Number(row.costUsd)).toBeGreaterThan(0);
    expect(row.model).toBe(STUB_LLM_MODEL);
  });

  it("(c) called twice with same reportId → only ONE row (dedup via onConflictDoNothing)", async () => {
    const reqId = "req-deep-dedup-001";
    const reportId = randomUuid();
    await seedUsageLog(reqId);

    const first = await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: reqId,
      sleepMs: noopSleep,
    });
    const second = await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: reqId,
      sleepMs: noopSleep,
    });

    expect(first.written).toBe(true);
    expect(second.written).toBe(false); // conflict → no-op
    expect(await countLedger(reportId)).toBe(1);
  });

  it("recovered deep-analysis cost is reflected in getMonthSpend", async () => {
    const reqId = "req-deep-spend-001";
    const reportId = randomUuid();
    await seedUsageLog(reqId, { totalCost: "0.2500000000" });

    const deps = createBudgetDeps(db);
    const before = await deps.getMonthSpend(orgId, monthStartUtc(new Date()));

    await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: reqId,
      sleepMs: noopSleep,
    });

    const after = await deps.getMonthSpend(orgId, monthStartUtc(new Date()));
    expect(after - before).toBeCloseTo(0.25, 6);
  });

  it("usage_log row never materializes → no row written (no placeholder), written:false", async () => {
    const reportId = randomUuid();
    const res = await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_PERSON,
      usageLogRequestId: "req-deep-missing-001",
      sleepMs: noopSleep,
    });

    expect(res.written).toBe(false);
    expect(await countLedger(reportId)).toBe(0);
  });

  it("refType is parameterised so PR3 can pass the per-key variant", async () => {
    const reqId = "req-deep-bykey-001";
    const reportId = randomUuid();
    await seedUsageLog(reqId);

    await writeDeepAnalysisLedger({
      db,
      orgId,
      reportId,
      refType: REF_TYPE_KEY,
      usageLogRequestId: reqId,
      sleepMs: noopSleep,
    });

    const rows = await db
      .select()
      .from(llmUsageEvents)
      .where(
        and(
          eq(llmUsageEvents.refId, reportId),
          eq(llmUsageEvents.refType, REF_TYPE_KEY),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
