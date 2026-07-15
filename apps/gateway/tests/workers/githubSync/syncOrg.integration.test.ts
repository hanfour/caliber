/**
 * Integration tests for PR1 Task 12: `syncOrg` orchestrator.
 *
 * Exercises decrypt → list repos ∩ allowlist → per-repo pulls+issues sync
 * with failure isolation → org Projects v2 → persisted connection status,
 * end-to-end over a real Postgres testcontainer + the real
 * `createGithubClient` driven by a route-based fake `fetch` (no HTTP mocking
 * library — same idiom as githubClient.test.ts). The seeded connection row
 * carries a REAL sealed token via `encryptCredential` so `decryptCredential`
 * runs for real inside `syncOrg`.
 *
 * Container + migrate boilerplate + `insertOrg` copied from
 * apps/gateway/tests/workers/githubSync/syncPulls.integration.test.ts.
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
import { eq } from "drizzle-orm";
import { encryptCredential } from "@caliber/gateway-core";
import { organizations, githubConnections, type Database } from "@caliber/db";
import { syncOrg } from "../../../src/workers/githubSync/syncOrg.js";

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
      slug: `sync-org-test-org-${suffix}`,
      name: `Sync Org Test Org ${suffix}`,
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

describe("syncOrg", () => {
  it("happy path: decrypts PAT, honors allowlist, syncs, sets status ok", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id, { repoAllowlist: ["acme/web"] });
    const fetchImpl = routeFetch({
      "/orgs/acme/repos": () =>
        json([{ full_name: "acme/web" }, { full_name: "acme/api" }]),
      "/repos/acme/web/pulls/1/reviews": () => json([]),
      "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
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
    const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
    expect(res.status).toBe("ok");
    expect(res.repos).toBe(1); // allowlist filtered acme/api out
    expect(res.pulls).toBe(1);
    const conn = (
      await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id))
    )[0]!;
    expect(conn.status).toBe("ok");
    expect(conn.lastSyncAt).not.toBeNull();
    expect(conn.lastSyncError).toBeNull();
  });

  it("isolates per-repo failures and never leaks the token in lastSyncError", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    const fetchImpl = routeFetch({
      "/orgs/acme/repos": () =>
        json([{ full_name: "acme/bad" }, { full_name: "acme/web" }]),
      "/repos/acme/bad/pulls": () => json({ message: `boom ${TOKEN}` }, 500),
      "/repos/acme/bad/issues": () => json([]),
      "/repos/acme/web/pulls/1/reviews": () => json([]),
      "/repos/acme/web/pulls/1": () => json(PULL_DETAIL),
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
    const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
    expect(res.status).toBe("sync_error");
    expect(res.pulls).toBe(1); // acme/web still synced
    const conn = (
      await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id))
    )[0]!;
    expect(conn.status).toBe("sync_error");
    expect(conn.lastSyncError).toContain("acme/bad");
    expect(conn.lastSyncError).not.toContain(TOKEN);
  });

  it("401 on repo listing → auth_error, no throw", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    const fetchImpl = routeFetch({
      "/orgs/acme/repos": () => json({ message: "Bad credentials" }, 401),
    });
    const res = await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id, fetchImpl });
    expect(res.status).toBe("auth_error");
    const conn = (
      await db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id))
    )[0]!;
    expect(conn.status).toBe("auth_error");
  });

  it("skips when no connection or disabled", async () => {
    const org = await insertOrg(db);
    expect(
      (await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id })).skippedReason,
    ).toBe("no_connection");
    await insertConnection(db, org.id, { deliveryEnabled: false });
    expect(
      (await syncOrg({ db, masterKeyHex: MASTER_KEY, orgId: org.id })).skippedReason,
    ).toBe("disabled");
  });
});
