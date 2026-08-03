/**
 * Regression test for the single-request-replay pollution defence.
 *
 * Replay traffic goes through the real gateway and therefore produces a real
 * `usage_logs` row.  Without this defence every replay would silently inflate
 * some team member's performance score — the failure mode is "someone's
 * appraisal gained a few points" and nobody would notice.
 *
 * The property fixed here: adding a replay row to the SAME user, org, period
 * and api_key must leave the rule-based scoring output byte-identical.  The
 * seeded replay row is deliberately extreme (100k input tokens, no cache
 * reads, a different model, a `refusal` stop reason) so that if it ever leaked
 * into the scoring window, every derived signal — and the total score — would
 * move.
 *
 * Judgement rule for future queries: "what did this person do in this period"
 * → `usageLogsScored`; "what did this one request cost" → `usageLogs`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  apiKeys,
  organizations,
  requestBodies,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@caliber/db";
import { encryptBody } from "../../../src/capture/encrypt.js";
import { runRuleBased } from "../../../src/workers/evaluator/runRuleBased.js";
import { platformDefaultRubric } from "../../../src/workers/evaluator/fixtures/platformDefault.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// Fixed 32-byte master key for tests (hex = 64 chars)
const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;
let apiKeyId: string;

const PERIOD_START = new Date("2024-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-01-02T00:00:00.000Z");
// Mid-window timestamp — every seeded row (normal and replay) lands here so
// the replay row cannot be excluded by the period predicate.
const WINDOW_MIDDLE = new Date("2024-01-01T10:00:00.000Z");

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "replay-exclusion-test-org",
      name: "Replay Exclusion Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "replay-exclusion-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-upstream",
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
      keyHash: `hash-replay-exclusion-${Math.random().toString(36).slice(2)}`,
      keyPrefix: "rpx-test",
      name: "replay-exclusion-test-key",
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
  // request_bodies is truncated transitively via its FK to usage_logs.
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRuleBasedInput() {
  return {
    db,
    masterKeyHex: TEST_MASTER_KEY,
    orgId,
    userId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    rubric: platformDefaultRubric,
  };
}

interface SeedUsageLogOptions {
  requestId: string;
  requestedModel?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  totalCost?: string;
  createdAt?: Date;
  replayOfRequestId?: string | null;
}

async function seedUsageLog(opts: SeedUsageLogOptions): Promise<void> {
  await db.insert(usageLogs).values({
    requestId: opts.requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: opts.requestedModel ?? "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: opts.cacheReadTokens ?? 50,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0.0001000000",
    totalCost: opts.totalCost ?? "0.0031000000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 1000,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
    createdAt: opts.createdAt ?? WINDOW_MIDDLE,
    replayOfRequestId: opts.replayOfRequestId ?? null,
  });
}

async function seedRequestBody(
  requestId: string,
  stopReason = "end_turn",
): Promise<void> {
  const sealBody = (plaintext: string) =>
    encryptBody({ masterKeyHex: TEST_MASTER_KEY, requestId, plaintext }).sealed;

  await db.insert(requestBodies).values({
    requestId,
    orgId,
    requestBodySealed: sealBody(
      JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "Hello!" }],
      }),
    ),
    responseBodySealed: sealBody(
      JSON.stringify({
        content: [{ type: "text", text: "Hi there!" }],
        stop_reason: stopReason,
      }),
    ),
    stopReason,
    clientUserAgent: "test-agent/1.0",
    clientSessionId: null,
    retentionUntil: new Date("2024-07-01T00:00:00.000Z"),
  });
}

/** Count the rows the scoring window's predicate would match on the raw table. */
async function countRawRowsInWindow(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.orgId, orgId),
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, PERIOD_START),
        lt(usageLogs.createdAt, PERIOD_END),
      ),
    );
  return rows[0]!.n;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("replay must not affect scoring", () => {
  it("adding a replay usage_log leaves the rule-based score completely unchanged", async () => {
    const normalRequestIds = [
      "req-replay-excl-001",
      "req-replay-excl-002",
      "req-replay-excl-003",
    ];
    for (const requestId of normalRequestIds) {
      await seedUsageLog({ requestId });
      await seedRequestBody(requestId);
    }

    const before = await runRuleBased(makeRuleBasedInput());
    expect(before.skipped).toBe(false);
    expect(before.report.dataQuality.totalRequests).toBe(3);

    // Same user, org, api_key and window as the normal rows — the ONLY
    // difference is the replay marker. Values are extreme so that leaking the
    // row into scoring moves cache_read_ratio, refusal_rate, model_mix, the
    // token/cost sums and the total score all at once.
    const replayRequestId = "req-replay-excl-replay-001";
    await seedUsageLog({
      requestId: replayRequestId,
      replayOfRequestId: normalRequestIds[0]!,
      requestedModel: "claude-opus-4-1",
      inputTokens: 100_000,
      cacheReadTokens: 0,
      totalCost: "9.9900000000",
    });
    await seedRequestBody(replayRequestId, "refusal");

    // Fixture sanity: the replay row really is in the table AND really does
    // satisfy the scoring window's predicate. Without this, a test that goes
    // green after the fix proves nothing.
    expect(await countRawRowsInWindow()).toBe(4);

    const after = await runRuleBased(makeRuleBasedInput());

    // Equality, not approximation. totalScore and signalsSummary are called
    // out separately because they fail with a readable diff; the whole-report
    // comparison is the actual guarantee (sectionScores, dataQuality and
    // insufficientData included).
    expect(after.report.totalScore).toBe(before.report.totalScore);
    expect(after.report.signalsSummary).toEqual(before.report.signalsSummary);
    expect(after.report).toEqual(before.report);

    // source_breakdown is persisted onto the report, so it is scoring output
    // too: a replay is not a gateway event this person produced.
    expect(after.sourceBreakdown).toEqual(before.sourceBreakdown);
    expect(after.skipped).toBe(before.skipped);

    // The replay's request_body must not reach the scorer either — body rows
    // are scoped transitively by the usage query's request IDs.
    expect(after.bodies.map((b) => b.requestId).sort()).toEqual(
      before.bodies.map((b) => b.requestId).sort(),
    );
    expect(after.bodies.map((b) => b.requestId)).not.toContain(
      replayRequestId,
    );
  });

  it("per-key scoring (apiKeyId grain) also excludes replays", async () => {
    const requestId = "req-replay-excl-key-001";
    await seedUsageLog({ requestId });
    await seedRequestBody(requestId);

    const perKeyInput = { ...makeRuleBasedInput(), apiKeyId };
    const before = await runRuleBased(perKeyInput);
    expect(before.report.dataQuality.totalRequests).toBe(1);

    await seedUsageLog({
      requestId: "req-replay-excl-key-replay-001",
      replayOfRequestId: requestId,
      requestedModel: "claude-opus-4-1",
      inputTokens: 100_000,
      cacheReadTokens: 0,
    });
    expect(await countRawRowsInWindow()).toBe(2);

    const after = await runRuleBased(perKeyInput);

    expect(after.report).toEqual(before.report);
    expect(after.sourceBreakdown).toEqual(before.sourceBreakdown);
  });
});
