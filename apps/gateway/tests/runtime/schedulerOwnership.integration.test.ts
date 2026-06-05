/**
 * Integration tests for Task 11 — the BYOK isolation core in the scheduler.
 *
 * Exercises `listSchedulableCandidates` directly (the candidate query that
 * feeds every scheduler layer) against a real Postgres testcontainer to prove
 * the two security invariants of user-scoped routing:
 *
 *   INV1 — a `pool` request must NEVER return a user-owned upstream. The pool
 *          path filters `user_id IS NULL`.
 *   INV2 — an `own` request returns ONLY the caller's upstreams
 *          (`user_id = req.userId`), ignoring groups, for the request's
 *          platform.
 *
 *   own_then_pool — runs the own query; if the caller owns nothing, falls back
 *          to the legacy org/team pool path (which also excludes user-owned
 *          upstreams). If the caller owns something, returns the own rows and
 *          never touches the pool.
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
import { sql } from "drizzle-orm";
import { organizations, users, upstreamAccounts } from "@caliber/db";
import {
  listSchedulableCandidates,
  type ScheduleRequest,
} from "../../src/runtime/scheduler.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;
let userAId: string;
let userBId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "byok-ownership-test-org", name: "BYOK Ownership Test" })
    .returning();
  orgId = org!.id;

  const [userA] = await db
    .insert(users)
    .values({ email: "byok-owner-a@example.com" })
    .returning();
  userAId = userA!.id;

  const [userB] = await db
    .insert(users)
    .values({ email: "byok-owner-b@example.com" })
    .returning();
  userBId = userB!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE upstream_accounts RESTART IDENTITY CASCADE`,
  );
});

const baseAccount = {
  teamId: null as string | null,
  platform: "openai" as const,
  type: "api_key" as const,
  schedulable: true,
  status: "active" as const,
};

async function seedAccount(
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({ ...baseAccount, orgId, name: "anon", priority: 50, ...overrides })
    .returning();
  return acct!;
}

function poolReq(overrides: Partial<ScheduleRequest> = {}): ScheduleRequest {
  return {
    orgId,
    teamId: null,
    routingPolicy: "pool",
    userId: null,
    groupPlatform: "openai",
    ...overrides,
  };
}

function ownReq(
  userId: string,
  overrides: Partial<ScheduleRequest> = {},
): ScheduleRequest {
  return {
    orgId,
    teamId: null,
    routingPolicy: "own",
    userId,
    groupPlatform: "openai",
    ...overrides,
  };
}

const noExclusions = new Set<string>();

describe("listSchedulableCandidates — BYOK ownership isolation", () => {
  it("INV1: a pool request never returns a user-owned upstream", async () => {
    const pooled = await seedAccount({ name: "pooled" });
    const userOwned = await seedAccount({ name: "user-a-owned", userId: userAId });

    const candidates = await listSchedulableCandidates(
      db as never,
      poolReq(),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toContain(pooled.id);
    expect(ids).not.toContain(userOwned.id);
  });

  it("INV2: an own request returns only the caller's upstreams, not another user's", async () => {
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId });
    const ownedByB = await seedAccount({ name: "b-owned", userId: userBId });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toContain(ownedByA.id);
    expect(ids).not.toContain(ownedByB.id);
  });

  it("INV2: an own request also excludes the org pool (user_id IS NULL)", async () => {
    const pooled = await seedAccount({ name: "pooled" });
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toEqual([ownedByA.id]);
    expect(ids).not.toContain(pooled.id);
  });

  it("own returns empty (does NOT fall back) when the caller owns nothing", async () => {
    await seedAccount({ name: "pooled" });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId),
      noExclusions,
    );
    expect(candidates).toHaveLength(0);
  });

  it("own_then_pool: caller owns nothing → falls back to the pool upstream", async () => {
    const pooled = await seedAccount({ name: "pooled" });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId, { routingPolicy: "own_then_pool" }),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toEqual([pooled.id]);
  });

  it("own_then_pool: caller HAS an own upstream → returns own, not the pool", async () => {
    const pooled = await seedAccount({ name: "pooled" });
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId, { routingPolicy: "own_then_pool" }),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toEqual([ownedByA.id]);
    expect(ids).not.toContain(pooled.id);
  });

  it("own_then_pool fallback also excludes user-owned upstreams (INV1 on the fallback path)", async () => {
    // User A owns nothing → fall back to pool. User B's owned upstream must
    // NOT leak into A's pool fallback.
    const pooled = await seedAccount({ name: "pooled" });
    const ownedByB = await seedAccount({ name: "b-owned", userId: userBId });

    const candidates = await listSchedulableCandidates(
      db as never,
      ownReq(userAId, { routingPolicy: "own_then_pool" }),
      noExclusions,
    );
    const ids = candidates.map((c) => c.id);

    expect(ids).toEqual([pooled.id]);
    expect(ids).not.toContain(ownedByB.id);
  });
});
