/**
 * Integration tests for PR2 Task 8: `startGithubDeliveryCron` +
 * `shouldRunWeeklyDelivery`.
 *
 * Exercises the tick loop against a real Postgres testcontainer + a fake
 * in-memory queue (no Redis needed — the cron only enqueues, it never
 * processes jobs). Container + `insertOrg`/`insertConnection` copied from
 * apps/gateway/tests/workers/githubSync/syncOrg.integration.test.ts;
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
  organizationMembers,
  accounts,
  users,
  type Database,
} from "@caliber/db";
import {
  shouldRunWeeklyDelivery,
  startGithubDeliveryCron,
} from "../../../src/workers/githubDelivery/weeklyCron.js";
import { buildGithubDeliveryJobId } from "../../../src/workers/githubDelivery/queue.js";

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
      slug: `weekly-cron-test-org-${suffix}`,
      name: `Weekly Cron Test Org ${suffix}`,
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

// ── Tests ────────────────────────────────────────────────────────────────────

const MONDAY_03 = new Date("2026-07-20T03:15:00Z"); // 2026-07-20 is a Monday
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("startGithubDeliveryCron", () => {
  it("shouldRunWeeklyDelivery: Monday 03 UTC only", () => {
    expect(shouldRunWeeklyDelivery(MONDAY_03)).toBe(true);
    expect(shouldRunWeeklyDelivery(new Date("2026-07-20T04:00:00Z"))).toBe(false); // Monday 04
    expect(shouldRunWeeklyDelivery(new Date("2026-07-21T03:00:00Z"))).toBe(false); // Tuesday 03
  });

  it("tick enqueues day-aligned rolling-30d jobs for attributed members of enabled connections only", async () => {
    const org = await insertOrg(db);
    await insertConnection(db, org.id);
    const withGh = await insertMember(db, 777);
    const [noGh] = await db
      .insert(users)
      .values({ email: `n-${Math.random().toString(36).slice(2)}@t.test`, name: "n" })
      .returning();
    await db.insert(organizationMembers).values([
      { orgId: org.id, userId: withGh.id },
      { orgId: org.id, userId: noGh!.id },
    ]);
    const disabledOrg = await insertOrg(db);
    await insertConnection(db, disabledOrg.id, { deliveryEnabled: false });
    const dm = await insertMember(db, 888);
    await db.insert(organizationMembers).values({ orgId: disabledOrg.id, userId: dm.id });

    const added: Array<{ data: Record<string, unknown>; opts?: { jobId?: string } }> = [];
    const queue = {
      add: async (_n: string, data: unknown, opts?: { jobId?: string }) =>
        void added.push({ data: data as Record<string, unknown>, opts }),
    };

    const handle = startGithubDeliveryCron({ db, queue, logger: noopLogger, clock: () => MONDAY_03 });
    added.length = 0; // discard the start-time tick
    await handle.tick();
    handle.stop(); // stop AFTER tick (PR1 interval lesson)

    expect(added).toHaveLength(1); // only the attributed member of the enabled org
    const p = added[0]!.data;
    expect(p.userId).toBe(withGh.id);
    expect(p.triggeredBy).toBe("cron");
    expect(p.periodEnd).toBe("2026-07-20T00:00:00.000Z");
    expect(p.periodStart).toBe("2026-06-20T00:00:00.000Z");
    expect(added[0]!.opts?.jobId).toBe(
      buildGithubDeliveryJobId({ orgId: org.id, userId: withGh.id, periodStart: p.periodStart as string }),
    );
  });

  it("tick is a no-op outside the Monday-03 window", async () => {
    const added: unknown[] = [];
    const queue = { add: async (...a: unknown[]) => void added.push(a) };
    const handle = startGithubDeliveryCron({
      db,
      queue,
      logger: noopLogger,
      clock: () => new Date("2026-07-21T03:00:00Z"),
    });
    added.length = 0;
    await handle.tick();
    handle.stop();
    expect(added).toHaveLength(0);
  });
});
