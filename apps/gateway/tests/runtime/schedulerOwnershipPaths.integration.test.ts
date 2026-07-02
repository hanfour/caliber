/**
 * Integration tests for Task 12 — ownership re-validation on the scheduler's
 * NON-candidate resolution paths (invariant §1.3.3).
 *
 * `listSchedulableCandidates` (Task 11) enforces ownership as SQL predicates,
 * but the scheduler also resolves an `accountId` through two other paths that
 * bypass that query:
 *
 *   - the FORCED / probe path — a caller names a specific account via
 *     `stickyAccountId` (e.g. probeAccount), resolved by
 *     `loadSchedulableAccount`;
 *   - the STICKY layers — Layer 1 `previous_response_id` and Layer 2
 *     `session_hash` return a previously-bound `accountId` from Redis, also
 *     resolved by `loadSchedulableAccount`.
 *
 * A stale sticky entry (written when the account was pooled, before it became
 * user-owned) or an arbitrary forced id could otherwise hand back an account
 * that VIOLATES the request's routing policy. Both paths must re-validate the
 * loaded row against `ownershipOk` before use.
 *
 *   Forced — user A forces user B's account under policy `own` → rejected
 *            (returns null; not honoured).
 *   Sticky — a sticky entry pointing at an account that is now `user_id != null`
 *            is rejected on a `pool` request; the scheduler falls through to
 *            normal candidate selection instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import path from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import {
  accountGroupMembers,
  accountGroups,
  organizations,
  users,
  upstreamAccounts,
} from "@caliber/db";
import {
  createScheduler,
  loadSchedulableAccount,
  type AccountScheduler,
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
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "byok-paths-test-org", name: "BYOK Paths Test" })
    .returning();
  orgId = org!.id;

  const [userA] = await db
    .insert(users)
    .values({ email: "byok-paths-a@example.com" })
    .returning();
  userAId = userA!.id;

  const [userB] = await db
    .insert(users)
    .values({ email: "byok-paths-b@example.com" })
    .returning();
  userBId = userB!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE upstream_accounts, account_groups, account_group_members RESTART IDENTITY CASCADE`,
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

async function seedGroup(name = "default") {
  const [group] = await db
    .insert(accountGroups)
    .values({ orgId, name, platform: "openai" })
    .returning();
  return group!;
}

async function attachToGroup(accountId: string, groupId: string, priority = 50) {
  await db.insert(accountGroupMembers).values({ accountId, groupId, priority });
}

function newRedis(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

function buildScheduler(redis?: Redis): AccountScheduler {
  return createScheduler({ db: db as never, redis });
}

describe("Task 12 — forced path ownership re-validation", () => {
  it("forced lookup of another user's account under `own` is rejected (null)", async () => {
    const ownedByB = await seedAccount({ name: "b-owned", userId: userBId });

    // User A forces user B's account under policy `own`.
    const req: ScheduleRequest = {
      orgId,
      teamId: null,
      routingPolicy: "own",
      userId: userAId,
      groupPlatform: "openai",
      stickyAccountId: ownedByB.id,
    };

    const account = await loadSchedulableAccount(db as never, ownedByB.id, req);
    expect(account).toBeNull();
  });

  it("forced lookup of the caller's OWN account under `own` is honoured", async () => {
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId });

    const req: ScheduleRequest = {
      orgId,
      teamId: null,
      routingPolicy: "own",
      userId: userAId,
      groupPlatform: "openai",
      stickyAccountId: ownedByA.id,
    };

    const account = await loadSchedulableAccount(db as never, ownedByA.id, req);
    expect(account?.id).toBe(ownedByA.id);
  });

  it("forced lookup of a user-owned account under `pool` is rejected (INV1)", async () => {
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId });

    const req: ScheduleRequest = {
      orgId,
      teamId: null,
      routingPolicy: "pool",
      userId: null,
      groupPlatform: "openai",
      stickyAccountId: ownedByA.id,
    };

    const account = await loadSchedulableAccount(db as never, ownedByA.id, req);
    expect(account).toBeNull();
  });

  it("forced lookup of a pool account under `pool` is honoured", async () => {
    const pooled = await seedAccount({ name: "pooled" });

    const req: ScheduleRequest = {
      orgId,
      teamId: null,
      routingPolicy: "pool",
      userId: null,
      groupPlatform: "openai",
      stickyAccountId: pooled.id,
    };

    const account = await loadSchedulableAccount(db as never, pooled.id, req);
    expect(account?.id).toBe(pooled.id);
  });
});

describe("Task 12 — sticky path ownership re-validation", () => {
  it("stale Layer 1 sticky pointing at a now-user-owned account is dropped on a `pool` request", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    // `stale` was sticky-bound while pooled, then became user-owned. It is
    // still a member of the group, so only the ownership re-validation (not
    // the membership/candidate query) keeps it out of a pool request.
    const stale = await seedAccount({ name: "stale-now-owned", userId: userAId });
    const pooled = await seedAccount({ name: "pooled", priority: 10 });
    await attachToGroup(stale.id, group.id);
    await attachToGroup(pooled.id, group.id);

    // Pre-seed the Layer 1 sticky entry pointing at the now-owned account.
    await redis.set(`sticky:resp:${group.id}:resp-stale`, stale.id, "EX", 3600);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "pool",
      userId: null,
      previousResponseId: "resp-stale",
    });

    // Re-validation rejects the stale sticky hit → falls through to candidate
    // selection, which (INV1) only sees the pooled account.
    expect(result.account.id).toBe(pooled.id);
    expect(result.decision.layer).toBe("load_balance");
  });

  it("stale Layer 2 sticky pointing at a now-user-owned account is dropped on a `pool` request", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const stale = await seedAccount({ name: "stale-now-owned", userId: userBId });
    const pooled = await seedAccount({ name: "pooled", priority: 10 });
    await attachToGroup(stale.id, group.id);
    await attachToGroup(pooled.id, group.id);

    await redis.set(`sticky:session:${group.id}:hash-stale`, stale.id, "EX", 1800);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "pool",
      userId: null,
      sessionHash: "hash-stale",
    });

    expect(result.account.id).toBe(pooled.id);
    expect(result.decision.layer).toBe("load_balance");
  });

  it("a pool sticky hit is still honoured when the account stayed pooled", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const pooledA = await seedAccount({ name: "a", priority: 10 });
    const pooledB = await seedAccount({ name: "b", priority: 20 });
    await attachToGroup(pooledA.id, group.id);
    await attachToGroup(pooledB.id, group.id);

    await redis.set(`sticky:resp:${group.id}:resp-ok`, pooledA.id, "EX", 3600);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "pool",
      userId: null,
      previousResponseId: "resp-ok",
    });

    expect(result.account.id).toBe(pooledA.id);
    expect(result.decision.layer).toBe("previous_response_id");
    expect(result.decision.stickyHit).toBe(true);
  });

  // --- own_then_pool sticky coverage (guards || vs && in ownershipOk) ---

  it("own_then_pool: sticky hit pointing at caller's OWN account is honoured", async () => {
    const redis = newRedis();
    const group = await seedGroup("otp-group");
    // User A owns this account (user_id = userAId).
    const ownedByA = await seedAccount({ name: "a-owned", userId: userAId, priority: 10 });
    await attachToGroup(ownedByA.id, group.id);

    // Pre-seed a Layer 1 sticky entry pointing at A's own account.
    await redis.set(
      `sticky:resp:${group.id}:resp-own`,
      ownedByA.id,
      "EX",
      3600,
    );

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "own_then_pool",
      userId: userAId,
      previousResponseId: "resp-own",
    });

    // ownershipOk: own_then_pool + row.userId === req.userId → should honour.
    expect(result.account.id).toBe(ownedByA.id);
    expect(result.decision.layer).toBe("previous_response_id");
    expect(result.decision.stickyHit).toBe(true);
  });

  it("own_then_pool: sticky hit pointing at ANOTHER user's account is rejected (falls through)", async () => {
    const redis = newRedis();
    const group = await seedGroup("otp-reject-group");
    // Account owned by user B — should be rejected when user A is the caller.
    const ownedByB = await seedAccount({ name: "b-owned", userId: userBId, priority: 10 });
    // A fallback pool account for user A to land on after rejection.
    const fallback = await seedAccount({ name: "pool-fallback", priority: 20 });
    await attachToGroup(ownedByB.id, group.id);
    await attachToGroup(fallback.id, group.id);

    const respKey = `resp-otp-reject`;
    const redisKey = `sticky:resp:${group.id}:${respKey}`;

    // Pre-seed the stale sticky entry pointing at user B's account.
    await redis.set(redisKey, ownedByB.id, "EX", 3600);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "own_then_pool",
      userId: userAId,
      previousResponseId: respKey,
    });

    // ownershipOk: own_then_pool + row.userId === userBId !== userAId → rejected.
    // Falls through to load_balance (pooled fallback account, user_id IS NULL).
    expect(result.account.id).toBe(fallback.id);
    expect(result.decision.layer).toBe("load_balance");

    // Self-heal: the stale entry for B's account was deleted and immediately
    // re-bound to the layer-3 winner (fallback) by bindStickyKeys. Confirm the
    // re-bound key points at fallback, NOT at the previously-stale B-owned account.
    const remaining = await redis.get(redisKey);
    expect(remaining).toBe(fallback.id);
  });

  // --- Verify stale sticky eviction after ownership rejection ---

  it("stale Layer 1 sticky key is deleted from Redis after ownership rejection (and re-bound to layer-3 winner)", async () => {
    const redis = newRedis();
    const group = await seedGroup("eviction-l1-group");
    // Account now owned by user A — stale on a pool request.
    const stale = await seedAccount({ name: "stale-evict", userId: userAId, priority: 10 });
    const pooled = await seedAccount({ name: "pooled-evict", priority: 20 });
    await attachToGroup(stale.id, group.id);
    await attachToGroup(pooled.id, group.id);

    const respId = "resp-evict-l1";
    const redisKey = `sticky:resp:${group.id}:${respId}`;
    await redis.set(redisKey, stale.id, "EX", 3600);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "pool",
      userId: null,
      previousResponseId: respId,
    });

    // The stale entry was evicted and immediately re-bound to the layer-3 winner
    // (pooled) by bindStickyKeys. The key must no longer point at the stale account.
    expect(result.account.id).toBe(pooled.id);
    const remaining = await redis.get(redisKey);
    expect(remaining).toBe(pooled.id);
    expect(remaining).not.toBe(stale.id);
  });

  it("stale Layer 2 sticky key is deleted from Redis after ownership rejection (and re-bound to layer-3 winner)", async () => {
    const redis = newRedis();
    const group = await seedGroup("eviction-l2-group");
    const stale = await seedAccount({ name: "stale-evict-l2", userId: userBId, priority: 10 });
    const pooled = await seedAccount({ name: "pooled-evict-l2", priority: 20 });
    await attachToGroup(stale.id, group.id);
    await attachToGroup(pooled.id, group.id);

    const hash = "hash-evict-l2";
    const redisKey = `sticky:session:${group.id}:${hash}`;
    await redis.set(redisKey, stale.id, "EX", 1800);

    const scheduler = buildScheduler(redis);
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      groupPlatform: "openai",
      routingPolicy: "pool",
      userId: null,
      sessionHash: hash,
    });

    // Stale entry was evicted and re-bound to the layer-3 winner. Must not
    // point at the user-owned stale account any more.
    expect(result.account.id).toBe(pooled.id);
    const remaining = await redis.get(redisKey);
    expect(remaining).toBe(pooled.id);
    expect(remaining).not.toBe(stale.id);
  });

  it("forced path rejection does NOT delete any Redis key (no stale key involved)", async () => {
    const redis = newRedis();
    const group = await seedGroup("forced-no-del-group");
    // A pool account that user A tries to force via `own` policy.
    const pooled = await seedAccount({ name: "pooled-force", priority: 10 });
    await attachToGroup(pooled.id, group.id);

    // Plant a sentinel key unrelated to the forced path to confirm it's untouched.
    const sentinelKey = `sticky:resp:${group.id}:sentinel`;
    await redis.set(sentinelKey, "some-account-id", "EX", 3600);

    const scheduler = buildScheduler(redis);
    // Force a pool account under `own` policy → rejected because pool row has
    // user_id IS NULL which fails `own` (own requires user_id = req.userId).
    // Since this is the forced path, no sticky key should be deleted.
    try {
      await scheduler.select({
        orgId,
        teamId: null,
        groupId: group.id,
        groupPlatform: "openai",
        routingPolicy: "own",
        userId: userAId,
        stickyAccountId: pooled.id,
        // No previousResponseId or sessionHash — no sticky layers.
      });
    } catch {
      // May throw NoSchedulableAccountsError; that's fine — we only care about
      // the sentinel key being untouched.
    }

    // Sentinel must still exist — the forced path must NOT delete sticky keys.
    const sentinel = await redis.get(sentinelKey);
    expect(sentinel).toBe("some-account-id");
  });
});
