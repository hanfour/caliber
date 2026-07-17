/**
 * Integration tests for PR3 Task 5: `runDeliveryQuality` orchestrator.
 *
 * Exercises: org disabled/no-model skip → budget gate → connection lookup
 * + PAT decrypt → merged-PR sampling → per-PR GitHub fetch (real
 * `createGithubClient` driven by a route-based fake `fetch`, same idiom as
 * syncOrg.integration.test.ts) → loopback LLM call via the real
 * `createFacetLlmClient` → parse (with one retry) → cost poll + ledger.
 *
 * Container + migrate boilerplate + `insertOrg`/`insertConnection`/
 * `routeFetch`/`json`/`MASTER_KEY` copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts.
 * `seedUsageLog` FK-chain shape copied from
 * apps/gateway/tests/workers/evaluator/deepAnalysisBudget.integration.test.ts.
 * ioredis-mock eval-key seeding copied from
 * apps/gateway/tests/workers/evaluator/runFacetExtraction.integration.test.ts.
 *
 * usage_logs seeding choice: seeded for real (not asserting `costUsd: null`)
 * — the FK-chain helper (`seedUsageLog`) is cheap to reuse verbatim from the
 * deep-analysis precedent, and a real cost-recovery assertion is worth the
 * few extra inserts. See pr3-task-5-report.md for the full writeup.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { encryptCredential } from "@caliber/gateway-core";
import {
  organizations,
  githubConnections,
  githubPullRequests,
  usageLogs,
  llmUsageEvents,
  apiKeys,
  upstreamAccounts,
  users,
  type Database,
} from "@caliber/db";
import { runDeliveryQuality } from "../../../src/workers/githubDelivery/runDeliveryQuality.js";
import { LLM_KEY_REDIS_PREFIX } from "../../../src/workers/evaluator/runLlm.js";
import { EVAL_PIN_HEADER } from "../../../src/runtime/evalAccountPin.js";
import {
  DELIVERY_ANALYSIS_EVENT_TYPE,
  REF_TYPE_GITHUB_DELIVERY_REPORT,
} from "../../../src/workers/evaluator/ledgerDeepAnalysis.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const MASTER_KEY = "ab".repeat(32); // 64 hex chars
const TOKEN = "github_pat_TESTTOKEN00000000000000";
const STUB_MODEL = "claude-haiku-4-5-20251001";
const STUB_RAW_KEY = "caliber-eval-deadbeefdeadbeefdeadbeefdeadbeef";
const GH_USER_ID = 4242;

const noopSleep = async (_ms: number): Promise<void> => {};

// ── Containers + shared state ────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;
const redis = new RedisMock() as unknown as Redis;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Seed a fresh org (unique slug per call — each `it` seeds its own). */
async function insertOrg(
  db: Database,
  overrides: Partial<typeof organizations.$inferInsert> = {},
) {
  const suffix = Math.random().toString(36).slice(2);
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `run-delivery-quality-test-org-${suffix}`,
      name: `Run Delivery Quality Test Org ${suffix}`,
      llmEvalEnabled: true,
      llmEvalModel: STUB_MODEL,
      ...overrides,
    })
    .returning();
  return org!;
}

async function insertConnection(
  db: Database,
  orgId: string,
  overrides: Partial<typeof githubConnections.$inferInsert> = {},
) {
  const id = crypto.randomUUID();
  const sealed = encryptCredential({
    masterKeyHex: MASTER_KEY,
    accountId: id,
    plaintext: TOKEN,
  });
  const [row] = await db
    .insert(githubConnections)
    .values({
      id,
      orgId,
      ownerLogin: "acme",
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      tokenLast4: TOKEN.slice(-4),
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertMergedPr(
  db: Database,
  params: {
    orgId: string;
    ghUserId: number;
    repoFullName: string;
    number: number;
    title?: string;
    additions?: number;
    deletions?: number;
    mergedAt: Date;
  },
) {
  await db.insert(githubPullRequests).values({
    orgId: params.orgId,
    repoFullName: params.repoFullName,
    number: params.number,
    ghNodeId: `PR_${params.orgId}_${params.number}`,
    authorGhId: params.ghUserId,
    authorLogin: "member",
    state: "closed",
    draft: false,
    title: params.title ?? "a change",
    htmlUrl: `https://github.com/${params.repoFullName}/pull/${params.number}`,
    baseRef: "main",
    additions: params.additions ?? 20,
    deletions: params.deletions ?? 5,
    ghCreatedAt: new Date(params.mergedAt.getTime() - 2 * 24 * 60 * 60 * 1000),
    mergedAt: params.mergedAt,
  });
}

/** FK-chain seed for a usage_logs row (copied shape from deepAnalysisBudget.integration.test.ts). */
async function seedUsageLog(
  db: Database,
  orgId: string,
  requestId: string,
  opts: { totalCost?: string; inputTokens?: number; outputTokens?: number } = {},
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(users)
    .values({ email: `uq-${suffix}@t.test` })
    .returning();
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({ orgId, name: `uq-upstream-${suffix}`, platform: "anthropic", type: "oauth" })
    .returning();
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: user!.id,
      orgId,
      keyHash: `hash-uq-${suffix}`,
      keyPrefix: "uq-test",
      name: "uq-key",
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });

  await db.insert(usageLogs).values({
    requestId,
    userId: user!.id,
    apiKeyId: key!.id,
    accountId: acct!.id,
    orgId,
    teamId: null,
    requestedModel: STUB_MODEL,
    upstreamModel: STUB_MODEL,
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: opts.inputTokens ?? 800,
    outputTokens: opts.outputTokens ?? 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: opts.totalCost ?? "0.0123400000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 900,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
  });
}

/**
 * Route-based fake fetch: dispatch on pathname (checked in insertion order —
 * more specific prefixes MUST be registered before shorter ones they'd
 * otherwise shadow, e.g. ".../pulls/1/comments" before ".../pulls/1"), 404
 * otherwise. Handler also receives `init` so a single path (getPull vs.
 * getPullDiff both hit `/repos/{repo}/pulls/{number}`) can branch on the
 * `accept` header the real `githubClient.ts` sets.
 */
function routeFetch(
  routes: Record<string, (url: URL, init?: RequestInit) => Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(url, init);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function pullDetailOrDiff(init: RequestInit | undefined, body: string): Response {
  const headers = init?.headers as Record<string, string> | undefined;
  const accept = headers?.accept ?? headers?.Accept;
  if (accept && accept.includes("diff")) {
    return new Response("diff --git a/f.ts b/f.ts\n+added a line of real code\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return json({
    number: 1,
    node_id: "PR_1",
    state: "closed",
    draft: false,
    title: "t",
    html_url: "https://github.com/acme/web/pull/1",
    user: { id: GH_USER_ID, login: "member" },
    base: { ref: "main" },
    additions: 20,
    deletions: 5,
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    merged_at: "2026-07-02T00:00:00Z",
    closed_at: "2026-07-02T00:00:00Z",
    body,
  });
}

const VALID_QUALITY_BODY = {
  qualityAdjustment: 8,
  narrative:
    "這次的 PR 展現了扎實的工程紀律，測試涵蓋率高且說明清楚。程式碼結構清晰，評論回應也很積極。整體交付品質優於平均水準。",
  evidence: [
    { repo: "acme/web", prNumber: 1, quote: "added a line of real code", reason: "clear diff" },
  ],
};

function llmOk(requestId: string, body: unknown = VALID_QUALITY_BODY): Response {
  return json(
    {
      content: [{ type: "text", text: JSON.stringify(body) }],
      usage: { input_tokens: 800, output_tokens: 200 },
    },
    200,
    { "x-request-id": requestId },
  );
}

function llmInvalid(requestId: string): Response {
  return json(
    { content: [{ type: "text", text: "not valid json {{{" }], usage: { input_tokens: 10, output_tokens: 5 } },
    200,
    { "x-request-id": requestId },
  );
}

const WINDOW_END = new Date("2026-07-16T00:00:00Z");
const WINDOW_START = new Date(WINDOW_END.getTime() - 30 * 24 * 60 * 60 * 1000);
const MERGED_AT = new Date("2026-07-10T00:00:00Z");

function baseInput(overrides: Partial<Parameters<typeof runDeliveryQuality>[0]> = {}) {
  return {
    db,
    redis,
    gatewayBaseUrl: "http://localhost:3002",
    masterKeyHex: MASTER_KEY,
    ghUserId: GH_USER_ID,
    reportId: crypto.randomUUID(),
    window: { start: WINDOW_START, end: WINDOW_END },
    quant: {
      totalScore: 80,
      windowDays: 30,
      sections: [{ key: "lead_time", score: 70 }],
    },
    sleepMs: noopSleep,
    ...overrides,
  } as Parameters<typeof runDeliveryQuality>[0];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runDeliveryQuality", () => {
  it("org llm_eval_enabled=false → skipped disabled", async () => {
    const org = await insertOrg(db, { llmEvalEnabled: false });
    const result = await runDeliveryQuality(baseInput({ orgId: org.id }));
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("org llm_eval_model=null → skipped no_model", async () => {
    const org = await insertOrg(db, { llmEvalModel: null });
    const result = await runDeliveryQuality(baseInput({ orgId: org.id }));
    expect(result).toEqual({ status: "skipped", reason: "no_model" });
  });

  it("org halted this month → budget_denied", async () => {
    const org = await insertOrg(db, {
      llmHaltedUntilMonthEnd: true,
      llmHaltedAt: new Date(),
    });
    const result = await runDeliveryQuality(baseInput({ orgId: org.id }));
    expect(result).toEqual({ status: "budget_denied" });
  });

  it("budget denial increments the counter and fires the alert event (Task 5: delivery budget parity)", async () => {
    const org = await insertOrg(db, {
      llmHaltedUntilMonthEnd: true,
      llmHaltedAt: new Date(),
    });
    const events: Array<{ event: string }> = [];
    const inc = vi.fn();
    const result = await runDeliveryQuality(
      baseInput({
        orgId: org.id,
        metrics: {
          gwLlmBudgetWarnTotal: { inc },
          gwLlmBudgetExceededTotal: { inc },
          gwLlmCostUsdTotal: { inc },
        } as never,
        onBudgetEvent: (e) => void events.push(e),
      }),
    );

    expect(result.status).toBe("budget_denied");
    expect(inc).toHaveBeenCalled();
    expect(events.some((e) => e.event === "exceeded")).toBe(true);
  });

  it("no github connection → skipped no_connection", async () => {
    const org = await insertOrg(db);
    const result = await runDeliveryQuality(baseInput({ orgId: org.id }));
    expect(result).toEqual({ status: "skipped", reason: "no_connection" });
  });

  it("connection present but no merged PRs in window → skipped no_merged_prs", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    const result = await runDeliveryQuality(baseInput({ orgId: org.id }));
    expect(result).toEqual({ status: "skipped", reason: "no_merged_prs" });
  });

  it("ok path: valid JSON + x-request-id + seeded usage_logs → costUsd recovered, ledger written, pin header sent; repeat run dedups", async () => {
    const evalAccountId = crypto.randomUUID();
    const org = await insertOrg(db, { llmEvalAccountId: evalAccountId });
    await insertConnection(db, org.id);
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    const reqId = `req-quality-ok-${org.id}`;
    await seedUsageLog(db, org.id, reqId, { totalCost: "0.0500000000" });

    const fetchImpl = vi.fn(
      routeFetch({
        "/repos/acme/web/pulls/1/comments": () => json([{ body: "nice work", user: { id: 1, login: "r" } }]),
        "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
        "/v1/messages": () => llmOk(reqId),
      }),
    );

    const reportId = crypto.randomUUID();
    const result = await runDeliveryQuality(
      baseInput({ orgId: org.id, reportId, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.qualityAdjustment).toBe(8);
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(result.evidence).toHaveLength(1);
    expect(result.model).toBe(STUB_MODEL);
    expect(result.costUsd).toBeCloseTo(0.05, 6);

    // pin header present on the loopback call
    const messagesCall = fetchImpl.mock.calls.find(([u]) => String(u).includes("/v1/messages"));
    expect(messagesCall).toBeDefined();
    const callInit = messagesCall![1] as RequestInit;
    expect((callInit.headers as Record<string, string>)[EVAL_PIN_HEADER]).toBe(evalAccountId);

    const ledgerRows = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.refId, reportId));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.refType).toBe(REF_TYPE_GITHUB_DELIVERY_REPORT);
    expect(ledgerRows[0]!.eventType).toBe(DELIVERY_ANALYSIS_EVENT_TYPE);

    // Repeat run with the same reportId → dedup (still exactly 1 ledger row).
    const second = await runDeliveryQuality(
      baseInput({ orgId: org.id, reportId, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(second.status).toBe("ok");
    const ledgerRowsAfter = await db
      .select()
      .from(llmUsageEvents)
      .where(eq(llmUsageEvents.refId, reportId));
    expect(ledgerRowsAfter).toHaveLength(1);
  });

  it("qualityAdjustment 40 from the LLM is clamped to 15", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    const fetchImpl = routeFetch({
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
      "/v1/messages": () => llmOk("req-clamp-001", { ...VALID_QUALITY_BODY, qualityAdjustment: 40 }),
    });

    const result = await runDeliveryQuality(baseInput({ orgId: org.id, fetchImpl }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.qualityAdjustment).toBe(15);
  });

  it("first response invalid JSON, retry valid → ok after exactly 2 loopback calls", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    let messageCalls = 0;
    const fetchImpl = vi.fn(
      routeFetch({
        "/repos/acme/web/pulls/1/comments": () => json([]),
        "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
        "/v1/messages": () => {
          messageCalls++;
          return messageCalls === 1 ? llmInvalid("req-retry-1") : llmOk("req-retry-2");
        },
      }),
    );

    const result = await runDeliveryQuality(
      baseInput({ orgId: org.id, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(result.status).toBe("ok");

    const messagesCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/v1/messages"));
    expect(messagesCalls).toHaveLength(2);
  });

  it("both attempts invalid JSON → parse_error (terminal)", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    const fetchImpl = routeFetch({
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
      "/v1/messages": () => llmInvalid("req-parse-error"),
    });

    const result = await runDeliveryQuality(baseInput({ orgId: org.id, fetchImpl }));
    expect(result).toEqual({ status: "parse_error", model: STUB_MODEL });
  });

  it("a per-PR GitHub fetch failure drops that PR but the report still completes with the survivor", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    // acme/bad's diff 500s; acme/web succeeds.
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/bad",
      number: 9,
      additions: 500,
      deletions: 500,
      mergedAt: MERGED_AT,
    });
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    const warnCalls: unknown[] = [];
    const fetchImpl = routeFetch({
      "/repos/acme/bad/pulls/9": () => json({ message: "boom" }, 500),
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
      "/v1/messages": () => llmOk("req-partial-drop"),
    });

    const result = await runDeliveryQuality(
      baseInput({
        orgId: org.id,
        fetchImpl,
        logger: { info: () => {}, warn: (o) => void warnCalls.push(o), error: () => {} },
      }),
    );

    expect(result.status).toBe("ok");
    expect(warnCalls).toHaveLength(1);
  });

  it("LLM transport error (500 from loopback) rethrows so BullMQ retries the job", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    await insertMergedPr(db, {
      orgId: org.id,
      ghUserId: GH_USER_ID,
      repoFullName: "acme/web",
      number: 1,
      mergedAt: MERGED_AT,
    });
    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, STUB_RAW_KEY);

    const fetchImpl = routeFetch({
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, "PR body"),
      "/v1/messages": () => json({ error: "upstream" }, 500),
    });

    await expect(
      runDeliveryQuality(baseInput({ orgId: org.id, fetchImpl })),
    ).rejects.toThrow();
  });
});
