/**
 * Integration tests for PR2 Task 7: `runDeliveryEval` orchestrator.
 *
 * Exercises staleness-gated inline sync → attribution → pure metrics/score
 * → report upsert, end-to-end over a real Postgres testcontainer. The
 * sync half reuses `syncOrg`'s real `createGithubClient` driven by a
 * route-based fake `fetch` (no HTTP mocking library).
 *
 * Container + migrate boilerplate + `insertOrg`/`insertConnection`/
 * `routeFetch`/`json`/`PULL_DETAIL`/`MASTER_KEY` copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts.
 * `insertMember` copied from
 * apps/gateway/tests/workers/githubDelivery/fetchActivity.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { encryptCredential } from "@caliber/gateway-core";
import {
  organizations,
  githubConnections,
  githubPullRequests,
  githubReviews,
  githubDeliveryReports,
  accounts,
  users,
  type Database,
} from "@caliber/db";
import {
  runDeliveryEval,
  SYNC_STALE_AFTER_MS,
} from "../../../src/workers/githubDelivery/runDeliveryEval.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

const MASTER_KEY = "ab".repeat(32); // 64 hex chars
const TOKEN = "github_pat_TESTTOKEN00000000000000";

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
async function insertOrg(db: Database) {
  const suffix = Math.random().toString(36).slice(2);
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `run-delivery-eval-test-org-${suffix}`,
      name: `Run Delivery Eval Test Org ${suffix}`,
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

/** Route-based fake fetch: dispatch on pathname, 404 otherwise. */
function routeFetch(routes: Record<string, (url: URL) => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(prefix)) return handler(url);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

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
      now: NOW,
    });
    expect(res.skippedSync).toBe(true);
    expect(res.noIdentity).toBe(false);
    const report = (await db.select().from(githubDeliveryReports)).find(
      (r) => r.userId === member.id,
    )!;
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
    const fetchImpl = routeFetch({
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
    });
    const res = await runDeliveryEval({
      db,
      masterKeyHex: MASTER_KEY,
      payload: payload(org.id, member.id),
      fetchImpl,
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
    await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: p, now: NOW });
    await runDeliveryEval({ db, masterKeyHex: MASTER_KEY, payload: p, now: NOW });
    const rows = (await db.select().from(githubDeliveryReports)).filter(
      (r) => r.userId === member.id,
    );
    expect(rows).toHaveLength(1);
  });
});
