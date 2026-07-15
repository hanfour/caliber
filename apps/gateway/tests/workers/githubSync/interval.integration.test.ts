/**
 * Integration tests for PR1 Task 13: `startGithubSyncInterval`.
 *
 * Exercises the tick loop against a real Postgres testcontainer + a fake
 * in-memory `QueueLike` (no Redis needed — the interval only enqueues, it
 * never processes jobs). Verifies:
 *   - one dedup'd job per org with an enabled connection
 *   - disabled connections are skipped
 *   - deterministic jobId via `buildGithubSyncJobId`
 *   - every enqueued job carries `triggeredBy: "interval"`
 *
 * Container + `insertOrg`/`insertConnection` helpers copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts.
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
import { organizations, githubConnections, type Database } from "@caliber/db";
import { startGithubSyncInterval } from "../../../src/workers/githubSync/interval.js";
import { buildGithubSyncJobId } from "../../../src/workers/githubSync/queue.js";

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
      slug: `interval-test-org-${suffix}`,
      name: `Interval Test Org ${suffix}`,
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("startGithubSyncInterval", () => {
  it("tick enqueues one dedup'd job per enabled connection", async () => {
    const orgA = await insertOrg(db);
    const orgB = await insertOrg(db);
    const orgC = await insertOrg(db);
    await insertConnection(db, orgA.id);
    await insertConnection(db, orgB.id, { deliveryEnabled: false });
    await insertConnection(db, orgC.id);

    const added: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];
    const queue = {
      add: async (
        name: string,
        data: unknown,
        opts?: { jobId?: string },
      ) => void added.push({ name, data, opts }),
    };
    const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

    const handle = startGithubSyncInterval({
      db,
      queue,
      logger: noopLogger,
      intervalMs: 60 * 60 * 1000, // irrelevant; we call tick() directly
    });
    added.length = 0; // discard the start-time tick — test tick() deterministically
    await handle.tick();
    // NOTE: stop() only after tick() — stop() sets the stopped flag, which
    // aborts the enqueue loop mid-flight (graceful-shutdown behavior).
    handle.stop();

    const orgIds = added.map((a) => (a.data as { orgId: string }).orgId).sort();
    expect(orgIds).toEqual([orgA.id, orgC.id].sort());
    expect(added[0]!.opts?.jobId).toBe(
      buildGithubSyncJobId({ orgId: (added[0]!.data as { orgId: string }).orgId }),
    );
    expect(
      added.every((a) => (a.data as { triggeredBy: string }).triggeredBy === "interval"),
    ).toBe(true);
  });
});
