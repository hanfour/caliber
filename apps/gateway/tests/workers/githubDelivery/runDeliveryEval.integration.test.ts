/**
 * Integration tests for PR2 Task 7 / PR3 Task 6: `runDeliveryEval`
 * orchestrator.
 *
 * Exercises staleness-gated inline sync → attribution → pure metrics/score
 * → report upsert → (PR3) LLM quality-adjustment merge, end-to-end over a
 * real Postgres testcontainer. The sync half reuses `syncOrg`'s real
 * `createGithubClient` driven by a route-based fake `fetch` (no HTTP
 * mocking library); the quality half reuses `runDeliveryQuality`'s real
 * `createFacetLlmClient` the same way.
 *
 * Container + migrate boilerplate + `insertOrg`/`insertConnection`/
 * `routeFetch`/`json`/`PULL_DETAIL`/`MASTER_KEY` copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts.
 * `insertMember` copied from
 * apps/gateway/tests/workers/githubDelivery/fetchActivity.integration.test.ts.
 * `pullDetailOrDiff`/`llmOk`/`llmInvalid`/ioredis-mock eval-key seeding
 * copied from
 * apps/gateway/tests/workers/githubDelivery/runDeliveryQuality.integration.test.ts
 * (PR3 Task 5).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
  githubReviews,
  githubDeliveryReports,
  accounts,
  users,
  usageLogs,
  apiKeys,
  upstreamAccounts,
  type Database,
} from "@caliber/db";
import {
  runDeliveryEval,
  SYNC_STALE_AFTER_MS,
} from "../../../src/workers/githubDelivery/runDeliveryEval.js";
import { LLM_KEY_REDIS_PREFIX } from "../../../src/workers/evaluator/runLlm.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const MASTER_KEY = "ab".repeat(32); // 64 hex chars
const TOKEN = "github_pat_TESTTOKEN00000000000000";
const STUB_MODEL = "claude-haiku-4-5-20251001";

// ── Containers + shared state ────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

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
      slug: `run-delivery-eval-test-org-${suffix}`,
      name: `Run Delivery Eval Test Org ${suffix}`,
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

/** Seed a user + linked github account row. */
async function insertMember(db: Database, ghId: number) {
  const [u] = await db
    .insert(users)
    .values({
      email: `m${ghId}-${Math.random().toString(36).slice(2)}@t.test`,
      name: "m",
    })
    .returning();
  await db.insert(accounts).values({
    userId: u!.id,
    type: "oauth",
    provider: "github",
    providerAccountId: String(ghId),
  });
  return u!;
}

/** FK-chain seed for a usage_logs row, so the quality layer's cost-recovery
 * poll resolves immediately instead of exhausting its retries. Copied shape
 * from runDeliveryQuality.integration.test.ts (PR3 Task 5). */
async function seedUsageLog(
  db: Database,
  orgId: string,
  requestId: string,
  opts: { totalCost?: string } = {},
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(users)
    .values({ email: `ue-${suffix}@t.test` })
    .returning();
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({ orgId, name: `ue-upstream-${suffix}`, platform: "anthropic", type: "oauth" })
    .returning();
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: user!.id,
      orgId,
      keyHash: `hash-ue-${suffix}`,
      keyPrefix: "ue-test",
      name: "ue-key",
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
    inputTokens: 800,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: opts.totalCost ?? "0.0500000000",
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
 * Route-based fake fetch: dispatch on pathname, 404 otherwise. Handler also
 * receives `init` so a single path (getPull vs. getPullDiff both hit
 * `/repos/{repo}/pulls/{number}`) can branch on the `accept` header the
 * real `githubClient.ts` sets (needed by the PR3 quality-layer tests below;
 * existing sync-only handlers below simply ignore the extra argument).
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

/** Branch on the `accept` header to serve either the PR detail JSON or the
 * raw diff text from the same `/repos/{repo}/pulls/{number}` path — copied
 * from runDeliveryQuality.integration.test.ts (PR3 Task 5). */
function pullDetailOrDiff(
  init: RequestInit | undefined,
  ghUserId: number,
  body: string | null = "PR body",
): Response {
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
    node_id: "PR_QUALITY_1",
    state: "closed",
    draft: false,
    title: "t",
    html_url: "https://github.com/acme/web/pull/1",
    user: { id: ghUserId, login: "member" },
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

const QUALITY_BODY = {
  qualityAdjustment: 8,
  narrative:
    "這次的 PR 展現了扎實的工程紀律，測試涵蓋率高且說明清楚。整體交付品質優於平均水準。",
  evidence: [
    { repo: "acme/web", prNumber: 1, quote: "added a line of real code", reason: "clear diff" },
  ],
};

function llmOk(requestId: string, body: unknown = QUALITY_BODY): Response {
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

const PULL_DETAIL = {
  number: 1,
  node_id: "PR_1",
  state: "closed",
  draft: false,
  title: "t",
  html_url: "https://github.com/acme/web/pull/1",
  user: { id: 7, login: "h" },
  base: { ref: "main" },
  additions: 1,
  deletions: 1,
  changed_files: 1,
  commits: 1,
  review_comments: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  merged_at: "2026-07-02T00:00:00Z",
  closed_at: "2026-07-02T00:00:00Z",
};

// ── Tests ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-16T12:00:00Z");
const payload = (orgId: string, userId: string) => ({
  orgId,
  userId,
  periodStart: "2026-06-16T00:00:00.000Z",
  periodEnd: "2026-07-16T00:00:00.000Z",
  periodType: "daily" as const,
  triggeredBy: "manual" as const,
});

// redis/gatewayBaseUrl are REQUIRED on RunDeliveryEvalInput as of PR3 Task 6
// (threaded to the quality layer's loopback LLM key lookup). ioredis-mock +
// a dummy base URL are enough for the quant-only tests below, since the LLM
// call is never reached on those paths (org llm_eval_enabled defaults false,
// or the quant score is itself unusable) — no loopback route is registered
// for those tests, and the "insufficient data" test below asserts the
// /v1/messages route is never hit.
const redis = new RedisMock() as unknown as Redis;
const GATEWAY_BASE_URL = "http://localhost:3002";

describe("runDeliveryEval", () => {
  it("fresh sync is skipped; report upserted from existing activity rows", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id, {
      lastSyncAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    }); // 10min ago
    const member = await insertMember(db, 777);

    // seed one merged PR + reviews/issues to clear DELIVERY_MIN_EVENTS=3
    // (insert directly into githubPullRequests/githubReviews — same shapes
    // as Task 6's test): 1 merged PR authored by 777, + 2 reviews by 777
    // on someone else's (raw gh-id 888, no accounts row needed — PR/review
    // author columns are plain bigints, not FK'd to accounts) PRs →
    // totalEvents = 1 (pull) + 2 (reviews) = 3.
    await db.insert(githubPullRequests).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 1,
        ghNodeId: "PR_1",
        authorGhId: 777,
        authorLogin: "me",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 2,
        ghNodeId: "PR_2",
        authorGhId: 888,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 3,
        ghNodeId: "PR_3",
        authorGhId: 888,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
    await db.insert(githubReviews).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_1",
        prGhNodeId: "PR_2",
        reviewerGhId: 777,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-03T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_2",
        prGhNodeId: "PR_3",
        reviewerGhId: 777,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-03T00:00:00Z"),
      },
    ]);

    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, member.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      now: NOW,
    });
    expect(res.skippedSync).toBe(true);
    expect(res.noIdentity).toBe(false);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
    // org.llmEvalEnabled defaults false → quality layer fast-skips
    // ("disabled") without any loopback call, leaving the phase-1 quant
    // placeholder as today's report.
    expect(report.llmStatus).toBe("skipped");
    expect(report.insufficientData).toBe(false);
    expect(Number(report.totalScore)).toBeGreaterThan(0);
    expect(report.periodType).toBe("daily");
  });

  it("stale lastSyncAt triggers an inline sync first (fetch hits GitHub), then scores", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id, {
      lastSyncAt: new Date(NOW.getTime() - SYNC_STALE_AFTER_MS - 1000),
    });
    // Distinct gh-id from test 1's 777 — accounts.(provider, providerAccountId)
    // is a global unique constraint, not org-scoped, and this file's tests
    // share one testcontainer.
    const member = await insertMember(db, 778);
    const fetchImpl = vi.fn(
      routeFetch({
        "/orgs/acme/repos": () => json([{ full_name: "acme/web" }]),
        "/repos/acme/web/pulls/1/reviews": () => json([]),
        "/repos/acme/web/pulls/1": () =>
          json({
            ...PULL_DETAIL,
            user: { id: 778, login: "me" },
            merged_at: "2026-07-02T00:00:00Z",
          }),
        "/repos/acme/web/pulls": () =>
          json([{ number: 1, node_id: "PR_1", updated_at: "2026-07-02T00:00:00Z" }]),
        "/repos/acme/web/issues": () => json([]),
        "/graphql": () =>
          json({
            data: {
              organization: {
                projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          }),
      }),
    );
    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, member.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(res.skippedSync).toBe(false);
    // the PR synced inline is what got scored
    expect(
      (await db.select().from(githubPullRequests)).filter((p) => p.orgId === org.id),
    ).toHaveLength(1);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
    expect(report.insufficientData).toBe(true); // only 1 event < 3
    expect(report.totalScore).toBeNull();
    expect(report.llmStatus).toBe("skipped"); // insufficient data → no quality call at all
    // The binding semantics guarantee this: insufficientData/null-totalScore
    // short-circuits BEFORE runDeliveryQuality is ever invoked, so the
    // loopback LLM endpoint must never be hit — not even indirectly.
    const messagesCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/v1/messages"));
    expect(messagesCalls).toHaveLength(0);
  });

  it("inline sync failure (decrypt throws) is logged and never blocks the report", async () => {
    const org = await insertOrg(db);
    // Sealed with a DIFFERENT master key than the one runDeliveryEval is
    // given below, so decryptCredential throws (AES-GCM auth-tag mismatch)
    // before syncOrg's own try/catch has a chance to persist anything — the
    // path this test targets is the throw ahead of that try/catch, not a
    // per-repo sync_error that syncOrg already catches internally (a
    // full-500 routeFetch would just make syncOrg return normally).
    const WRONG_KEY = "cd".repeat(32);
    const id = crypto.randomUUID();
    const sealed = encryptCredential({
      masterKeyHex: WRONG_KEY,
      accountId: id,
      plaintext: TOKEN,
    });
    await db.insert(githubConnections).values({
      id,
      orgId: org.id,
      ownerLogin: "acme",
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      tokenLast4: TOKEN.slice(-4),
      lastSyncAt: new Date(NOW.getTime() - SYNC_STALE_AFTER_MS - 1000), // stale → sync attempted
    });
    // Distinct gh-id from the other tests — see note above insertMember.
    const member = await insertMember(db, 780);

    const warnCalls: Array<{ obj: unknown; msg?: string }> = [];
    const fakeLogger = {
      info: () => {},
      warn: (obj: unknown, msg?: string) => void warnCalls.push({ obj, msg }),
      error: () => {},
    };

    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY, // correct key — decrypting the wrong-key ciphertext throws
      payload: payload(org.id, member.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      now: NOW,
      logger: fakeLogger,
    });

    expect(res.skippedSync).toBe(false); // sync was attempted (stale), just failed
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.msg).toContain("inline sync failed");
    expect(warnCalls[0]!.obj).toMatchObject({ orgId: org.id });
    expect(String((warnCalls[0]!.obj as { err: unknown }).err)).not.toContain(TOKEN);

    // Existing degrade-gracefully semantics: the report still lands.
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
    expect(report.insufficientData).toBe(true); // no activity synced
  });

  it("member without a github account → noIdentity report, never an error", async () => {
    const org = await insertOrg(db);
    const [plain] = await db
      .insert(users)
      .values({ email: `p-${Math.random().toString(36).slice(2)}@t.test`, name: "p" })
      .returning();
    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, plain!.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      now: NOW,
    });
    expect(res.noIdentity).toBe(true);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === plain!.id,
    )!;
    expect(report.insufficientData).toBe(true);
    expect(report.metrics).toMatchObject({ noIdentity: true });
  });

  it("re-run upserts (no duplicate row) and refreshes the score", async () => {
    const org = await insertOrg(db);
    // Distinct gh-id from the earlier tests — see note above.
    const member = await insertMember(db, 779);
    const p = payload(org.id, member.id);
    await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: p,
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      now: NOW,
    });
    await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: p,
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      now: NOW,
    });
    const rows = (await db.select().from(githubDeliveryReports)).filter(
      (r) => r.userId === member.id,
    );
    expect(rows).toHaveLength(1);
  });

  it("LLM quality ok path: report gets llm_status ok, adjusted totalScore, and stored narrative", async () => {
    const evalAccountId = crypto.randomUUID();
    const org = await insertOrg(db, {
      llmEvalEnabled: true,
      llmEvalModel: STUB_MODEL,
      llmEvalAccountId: evalAccountId,
    });
    await insertConnection(db, org.id, {
      lastSyncAt: new Date(NOW.getTime() - 10 * 60 * 1000), // fresh → no inline sync
    });
    const ghUserId = 9001;
    const otherGhUserId = 9002;
    const member = await insertMember(db, ghUserId);

    // Same activity shape as test 1 (1 merged PR by the member + 2 reviews
    // by the member on another author's PRs, clearing DELIVERY_MIN_EVENTS=3)
    // but with a controlled lead time (96h, an exact 0.5 on the timeliness
    // curve) so the pre-LLM quant totalScore is a precise, hand-computed
    // literal: throughput 1/24 (weight .4) + collaboration 4/15 (weight .3)
    // + timeliness 1/2 (weight .3) → weighted 74/300 → 120*74/300 = 29.6.
    await db.insert(githubPullRequests).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 1,
        ghNodeId: "PR_OK_1",
        authorGhId: ghUserId,
        authorLogin: "me",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-05T00:00:00Z"), // exactly 96h after created
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 2,
        ghNodeId: "PR_OK_2",
        authorGhId: otherGhUserId,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 3,
        ghNodeId: "PR_OK_3",
        authorGhId: otherGhUserId,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
    await db.insert(githubReviews).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_OK_1",
        prGhNodeId: "PR_OK_2",
        reviewerGhId: ghUserId,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-06T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_OK_2",
        prGhNodeId: "PR_OK_3",
        reviewerGhId: ghUserId,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-06T00:00:00Z"),
      },
    ]);

    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, "caliber-eval-testkey");

    const reqId = `req-eval-ok-${org.id}`;
    await seedUsageLog(db, org.id, reqId, { totalCost: "0.0500000000" });

    // Only PR_OK_1 (authored by the member) is a quality-layer candidate —
    // the other two PRs are authored by otherGhUserId and only feed
    // reviews_submitted/distinct_prs_reviewed, never sampled for quality.
    const fetchImpl = routeFetch({
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, ghUserId),
      "/v1/messages": () => llmOk(reqId),
    });

    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, member.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      fetchImpl,
      now: NOW,
    });

    expect(res.skippedSync).toBe(true);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
    expect(report.llmStatus).toBe("ok");
    expect(report.insufficientData).toBe(false);
    // Pre-LLM quant literal, hand-computed above.
    const quantTotal = 29.6;
    expect(Number(report.totalScore)).toBeCloseTo(quantTotal + QUALITY_BODY.qualityAdjustment, 6);
    expect(report.llmQualityAdjustment).not.toBeNull();
    expect(Number(report.llmQualityAdjustment)).toBe(QUALITY_BODY.qualityAdjustment);
    expect(report.llmNarrative).toBe(QUALITY_BODY.narrative);
    expect(report.llmEvidence).toEqual(QUALITY_BODY.evidence);
    expect(report.llmModel).toBe(STUB_MODEL);
    expect(report.llmCalledAt).not.toBeNull();
    expect(Number(report.llmCostUsd)).toBeCloseTo(0.05, 6);
  });

  it("LLM quality parse_error path: totalScore stays the quant value, llm_status parse_error", async () => {
    const org = await insertOrg(db, { llmEvalEnabled: true, llmEvalModel: STUB_MODEL });
    await insertConnection(db, org.id, {
      lastSyncAt: new Date(NOW.getTime() - 10 * 60 * 1000), // fresh → no inline sync
    });
    const ghUserId = 9101;
    const otherGhUserId = 9102;
    const member = await insertMember(db, ghUserId);

    // Identical activity shape/dates to the ok-path test above → same
    // hand-computed pre-LLM quant literal (29.6), asserted unchanged below.
    await db.insert(githubPullRequests).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 1,
        ghNodeId: "PR_PARSEERR_1",
        authorGhId: ghUserId,
        authorLogin: "me",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-05T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 2,
        ghNodeId: "PR_PARSEERR_2",
        authorGhId: otherGhUserId,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        number: 3,
        ghNodeId: "PR_PARSEERR_3",
        authorGhId: otherGhUserId,
        authorLogin: "other",
        state: "closed",
        draft: false,
        title: "t",
        htmlUrl: "u",
        baseRef: "main",
        ghCreatedAt: new Date("2026-07-01T00:00:00Z"),
        mergedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
    await db.insert(githubReviews).values([
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_PARSEERR_1",
        prGhNodeId: "PR_PARSEERR_2",
        reviewerGhId: ghUserId,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-06T00:00:00Z"),
      },
      {
        orgId: org.id,
        repoFullName: "acme/web",
        ghNodeId: "R_PARSEERR_2",
        prGhNodeId: "PR_PARSEERR_3",
        reviewerGhId: ghUserId,
        reviewerLogin: "me",
        state: "APPROVED",
        submittedAt: new Date("2026-07-06T00:00:00Z"),
      },
    ]);

    await redis.set(`${LLM_KEY_REDIS_PREFIX}${org.id}`, "caliber-eval-testkey");

    // Both loopback attempts (initial + retry) return unparseable JSON.
    const fetchImpl = routeFetch({
      "/repos/acme/web/pulls/1/comments": () => json([]),
      "/repos/acme/web/pulls/1": (_url, init) => pullDetailOrDiff(init, ghUserId),
      "/v1/messages": () => llmInvalid("req-eval-parse-error"),
    });

    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, member.id),
      redis,
      gatewayBaseUrl: GATEWAY_BASE_URL,
      fetchImpl,
      now: NOW,
    });

    expect(res.skippedSync).toBe(true);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
    expect(report.llmStatus).toBe("parse_error");
    expect(report.llmModel).toBe(STUB_MODEL);
    // Quant totalScore is preserved exactly — the pre-LLM literal.
    expect(Number(report.totalScore)).toBe(29.6);
    expect(report.llmQualityAdjustment).toBeNull();
    expect(report.llmNarrative).toBeNull();
    expect(report.llmEvidence).toBeNull();
    expect(report.llmCostUsd).toBeNull();
  });
});
