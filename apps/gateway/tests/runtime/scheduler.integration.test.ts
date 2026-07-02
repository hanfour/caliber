import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import path from "node:path";
import { createRequire } from "node:module";
import {
  accountGroupMembers,
  accountGroups,
  organizations,
  upstreamAccounts,
} from "@caliber/db";
import {
  AccountRuntimeStats,
  createScheduler,
  NoSchedulableAccountsError,
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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  const [org] = await db
    .insert(organizations)
    .values({ slug: "scheduler-test-org", name: "Scheduler Test" })
    .returning();
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(accountGroupMembers);
  await db.delete(accountGroups);
  await db.delete(upstreamAccounts);
});

const baseAccount = {
  teamId: null as string | null,
  platform: "anthropic" as const,
  type: "api_key" as const,
  schedulable: true,
  status: "active" as const,
};

async function seedGroup(
  platform: "anthropic" | "openai" = "anthropic",
  name = "default",
) {
  const [group] = await db
    .insert(accountGroups)
    .values({ orgId, name, platform })
    .returning();
  return group!;
}

async function seedAccount(
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({ ...baseAccount, orgId, name: "anon", priority: 50, ...overrides })
    .returning();
  return acct!;
}

async function attachToGroup(
  accountId: string,
  groupId: string,
  priority = 50,
) {
  await db.insert(accountGroupMembers).values({ accountId, groupId, priority });
}

function newRedis(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

function buildScheduler(
  opts: {
    redis?: Redis;
    random?: () => number;
    stats?: AccountRuntimeStats;
  } = {},
): AccountScheduler {
  return createScheduler({
    db: db as never,
    redis: opts.redis,
    stats: opts.stats,
    random: opts.random,
  });
}

describe("scheduler.select — Layer 1 (previous_response_id sticky)", () => {
  it("returns the bound account when sticky entry hits", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    const acctB = await seedAccount({ name: "b", priority: 20 });
    await attachToGroup(acctA.id, group.id);
    await attachToGroup(acctB.id, group.id);
    await redis.set(`sticky:resp:${group.id}:resp-1`, acctA.id, "EX", 3600);

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "resp-1",
    });

    expect(result.account.id).toBe(acctA.id);
    expect(result.decision.layer).toBe("previous_response_id");
    expect(result.decision.stickyHit).toBe(true);
  });

  it("falls through to load_balance when sticky entry is missing", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    await attachToGroup(acctA.id, group.id);

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "missing-resp",
    });

    expect(result.decision.layer).toBe("load_balance");
    expect(result.decision.stickyHit).toBe(false);
    expect(result.account.id).toBe(acctA.id);
    // Layer 3 binds the previousResponseId on miss so subsequent calls hit Layer 1.
    const stored = await redis.get(`sticky:resp:${group.id}:missing-resp`);
    expect(stored).toBe(acctA.id);
  });

  it("falls through when sticky points at an excluded account", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    const acctB = await seedAccount({ name: "b", priority: 20 });
    await attachToGroup(acctA.id, group.id);
    await attachToGroup(acctB.id, group.id);
    await redis.set(`sticky:resp:${group.id}:resp-1`, acctA.id, "EX", 3600);

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "resp-1",
      excludedAccountIds: new Set([acctA.id]),
    });

    expect(result.decision.layer).toBe("load_balance");
    expect(result.account.id).toBe(acctB.id);
  });
});

describe("scheduler.select — Layer 2 (session_hash sticky)", () => {
  it("returns the bound account on session_hash hit", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    const acctB = await seedAccount({ name: "b", priority: 20 });
    await attachToGroup(acctA.id, group.id);
    await attachToGroup(acctB.id, group.id);
    await redis.set(`sticky:session:${group.id}:hash-1`, acctB.id, "EX", 1800);

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      sessionHash: "hash-1",
    });

    expect(result.decision.layer).toBe("session_hash");
    expect(result.account.id).toBe(acctB.id);
  });

  it("binds session_hash on Layer 3 miss so the next call hits Layer 2", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    await attachToGroup(acctA.id, group.id);

    const scheduler = buildScheduler({ redis });
    const first = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      sessionHash: "fresh-hash",
    });
    expect(first.decision.layer).toBe("load_balance");

    const second = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      sessionHash: "fresh-hash",
    });
    expect(second.decision.layer).toBe("session_hash");
    expect(second.account.id).toBe(first.account.id);
  });
});

describe("scheduler.select — Layer 3 (load_balance)", () => {
  it("weighted distribution lands within 20% of expected over 1000 runs", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    // priority 1 → basePriority 1.0; priority 2 → basePriority 0.5
    // expected ratio acctA : acctB = 2 : 1 over 1000 runs
    const acctA = await seedAccount({ name: "a", priority: 1 });
    const acctB = await seedAccount({ name: "b", priority: 2 });
    await attachToGroup(acctA.id, group.id, 1);
    await attachToGroup(acctB.id, group.id, 2);

    let seed = 0;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const scheduler = buildScheduler({ redis, random });

    const counts = { [acctA.id]: 0, [acctB.id]: 0 } as Record<string, number>;
    const runs = 1000;
    for (let i = 0; i < runs; i++) {
      // Use a fresh sessionHash each iter so Layer 2 doesn't pin us.
      const result = await scheduler.select({
        orgId,
        teamId: null,
        groupId: group.id,
        sessionHash: `iter-${i}`,
      });
      counts[result.account.id]!++;
    }

    const expectedA = (runs * 2) / 3; // ~666
    const expectedB = runs / 3; // ~333
    expect(counts[acctA.id]!).toBeGreaterThanOrEqual(expectedA * 0.8);
    expect(counts[acctA.id]!).toBeLessThanOrEqual(expectedA * 1.2);
    expect(counts[acctB.id]!).toBeGreaterThanOrEqual(expectedB * 0.8);
    expect(counts[acctB.id]!).toBeLessThanOrEqual(expectedB * 1.2);
  }, 30_000);

  it("excludes accounts in different groups", async () => {
    const redis = newRedis();
    const groupA = await seedGroup("anthropic", "groupA");
    const groupB = await seedGroup("anthropic", "groupB");
    const acctA = await seedAccount({ name: "in-A", priority: 10 });
    const acctB = await seedAccount({ name: "in-B", priority: 10 });
    await attachToGroup(acctA.id, groupA.id);
    await attachToGroup(acctB.id, groupB.id);

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: groupA.id,
    });
    expect(result.account.id).toBe(acctA.id);
    expect(result.decision.candidateCount).toBe(1);
  });

  it("throws NoSchedulableAccountsError when all candidates excluded", async () => {
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a" });
    await attachToGroup(acctA.id, group.id);

    const scheduler = buildScheduler();
    await expect(
      scheduler.select({
        orgId,
        teamId: null,
        groupId: group.id,
        excludedAccountIds: new Set([acctA.id]),
      }),
    ).rejects.toBeInstanceOf(NoSchedulableAccountsError);
  });

  it("returns oauth and apikey accounts as cross-type candidates within a group", async () => {
    const group = await seedGroup();
    const oauth = await seedAccount({
      name: "oauth-acct",
      type: "oauth_chatgpt",
      priority: 10,
    });
    const apikey = await seedAccount({
      name: "apikey-acct",
      type: "api_key",
      priority: 10,
    });
    await attachToGroup(oauth.id, group.id, 10);
    await attachToGroup(apikey.id, group.id, 10);

    const scheduler = buildScheduler();
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
    });
    expect(result.decision.candidateCount).toBe(2);
    expect([oauth.id, apikey.id]).toContain(result.account.id);
  });

  it("EWMA stats steer selection toward observed-fast accounts", async () => {
    const group = await seedGroup();
    const acctSlow = await seedAccount({ name: "slow", priority: 10 });
    const acctFast = await seedAccount({ name: "fast", priority: 10 });
    await attachToGroup(acctSlow.id, group.id, 10);
    await attachToGroup(acctFast.id, group.id, 10);

    const stats = new AccountRuntimeStats({ alpha: 1, ttftFloorMs: 100 });
    // alpha=1 → instant overwrite; mark slow at 1000ms, fast at 100ms.
    stats.record(acctSlow.id, true, 1000);
    stats.record(acctFast.id, true, 100);

    let seed = 1;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const scheduler = buildScheduler({ random, stats });

    let fastCount = 0;
    for (let i = 0; i < 200; i++) {
      const result = await scheduler.select({
        orgId,
        teamId: null,
        groupId: group.id,
        sessionHash: `iter-${i}`,
      });
      if (result.account.id === acctFast.id) fastCount++;
    }
    // Fast account weight = 1 * 1 * 1/100 = 0.01
    // Slow account weight = 1 * 1 * 1/1000 = 0.001
    // Expected ~10:1 → at least 80% of picks should be fast.
    expect(fastCount).toBeGreaterThanOrEqual(160);
  }, 30_000);
});

describe("scheduler.select — legacy (no groupId) behaviour", () => {
  it("falls back to deterministic priority-based selection (4A semantic)", async () => {
    const acctA = await seedAccount({ name: "a", priority: 1 });
    await seedAccount({ name: "b", priority: 2 });

    const scheduler = buildScheduler();
    const req: ScheduleRequest = { orgId, teamId: null };
    const r1 = await scheduler.select(req);
    const r2 = await scheduler.select(req);

    // Deterministic — both decisions pick the priority=1 account.
    expect(r1.account.id).toBe(acctA.id);
    expect(r2.account.id).toBe(acctA.id);
    expect(r1.decision.layer).toBe("load_balance");
  });

  // Regression guard: legacy api keys (no group_id) synthesise a platform
  // via groupContext (`anthropic` fallback). Before this fix the legacy
  // candidate query ignored platform, so an anthropic-routed request
  // could pick an OpenAI account and get marked `status='error'` for an
  // `invalid x-api-key` that was actually our own routing bug.
  it("filters out cross-platform candidates when groupPlatform=anthropic", async () => {
    const anthAcct = await seedAccount({
      name: "anth",
      priority: 50,
      platform: "anthropic",
    });
    // Lower priority number = higher preference; without the filter the
    // OpenAI account would win.
    await seedAccount({ name: "oai", priority: 1, platform: "openai" });

    const scheduler = buildScheduler();
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupPlatform: "anthropic",
    });
    expect(result.account.id).toBe(anthAcct.id);
    expect(result.account.platform).toBe("anthropic");
  });

  it("filters out cross-platform candidates when groupPlatform=openai", async () => {
    await seedAccount({ name: "anth", priority: 1, platform: "anthropic" });
    const oaiAcct = await seedAccount({
      name: "oai",
      priority: 50,
      platform: "openai",
    });

    const scheduler = buildScheduler();
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupPlatform: "openai",
    });
    expect(result.account.id).toBe(oaiAcct.id);
    expect(result.account.platform).toBe("openai");
  });

  it("throws NoSchedulableAccountsError when only cross-platform accounts exist", async () => {
    await seedAccount({ name: "oai", priority: 1, platform: "openai" });

    const scheduler = buildScheduler();
    await expect(
      scheduler.select({
        orgId,
        teamId: null,
        groupPlatform: "anthropic",
      }),
    ).rejects.toBeInstanceOf(NoSchedulableAccountsError);
  });
});

describe("scheduler.select — review gap coverage", () => {
  it("falls through to Layer 3 when Layer 1 cache points at a deleted account", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctStale = await seedAccount({ name: "stale", priority: 10 });
    const acctLive = await seedAccount({ name: "live", priority: 10 });
    await attachToGroup(acctStale.id, group.id, 10);
    await attachToGroup(acctLive.id, group.id, 10);
    await redis.set(
      `sticky:resp:${group.id}:resp-stale`,
      acctStale.id,
      "EX",
      3600,
    );

    // Tombstone the cached account after the sticky was written.
    await db
      .update(upstreamAccounts)
      .set({ deletedAt: new Date() })
      .where(eq(upstreamAccounts.id, acctStale.id));

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "resp-stale",
    });

    expect(result.decision.layer).toBe("load_balance");
    expect(result.account.id).toBe(acctLive.id);
  });

  it("stickyAccountId override surfaces as layer='forced' and bypasses sticky lookup", async () => {
    const redis = newRedis();
    const group = await seedGroup();
    const acctOverride = await seedAccount({ name: "forced", priority: 10 });
    const acctOther = await seedAccount({ name: "other", priority: 1 });
    await attachToGroup(acctOverride.id, group.id, 10);
    await attachToGroup(acctOther.id, group.id, 1);
    // Even with a sticky pointing somewhere else, the override wins.
    await redis.set(
      `sticky:resp:${group.id}:any-resp`,
      acctOther.id,
      "EX",
      3600,
    );

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "any-resp",
      stickyAccountId: acctOverride.id,
    });

    expect(result.decision.layer).toBe("forced");
    expect(result.decision.stickyHit).toBe(false);
    expect(result.account.id).toBe(acctOverride.id);
  });

  it("loadSchedulableAccount rejects cross-org accounts even when the cache hits", async () => {
    // Two orgs in the same DB; the cache could in theory be poisoned with
    // an account belonging to the wrong tenant.
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: `cross-${Date.now()}`, name: "Cross Org" })
      .returning();

    const redis = newRedis();
    const group = await seedGroup();
    const fallback = await seedAccount({ name: "fallback", priority: 10 });
    await attachToGroup(fallback.id, group.id, 10);

    // An account belonging to a different org.
    const [foreign] = await db
      .insert(upstreamAccounts)
      .values({
        ...baseAccount,
        orgId: otherOrg!.id,
        name: "foreign",
        priority: 1,
      })
      .returning();
    await redis.set(
      `sticky:resp:${group.id}:cross-tenant`,
      foreign!.id,
      "EX",
      3600,
    );

    const scheduler = buildScheduler({ redis });
    const result = await scheduler.select({
      orgId, // request scoped to the original org
      teamId: null,
      groupId: group.id,
      previousResponseId: "cross-tenant",
    });

    // Foreign account is filtered out by the orgId predicate; falls
    // through to Layer 3 + picks the in-org account.
    expect(result.account.id).toBe(fallback.id);
    expect(result.decision.layer).toBe("load_balance");
  });

  it("falls through gracefully when the sticky read throws (Redis flake)", async () => {
    const group = await seedGroup();
    const acct = await seedAccount({ name: "live", priority: 10 });
    await attachToGroup(acct.id, group.id, 10);

    const flakyRedis = newRedis();
    // Force `get` to reject so getRespSticky / getSessionSticky throw.
    (flakyRedis as unknown as { get: () => Promise<string | null> }).get = () =>
      Promise.reject(new Error("redis is on fire"));

    const stickyErrors: Array<{ layer: string }> = [];
    const scheduler = createScheduler({
      db: db as never,
      redis: flakyRedis,
      onStickyError: (_err, layer) => stickyErrors.push({ layer }),
    });

    const result = await scheduler.select({
      orgId,
      teamId: null,
      groupId: group.id,
      previousResponseId: "any",
      sessionHash: "any",
    });

    expect(result.decision.layer).toBe("load_balance");
    expect(result.account.id).toBe(acct.id);
    // Both sticky reads failed and surfaced via the error hook.
    expect(stickyErrors.map((e) => e.layer).sort()).toEqual([
      "resp",
      "session",
    ]);
  });
});

describe("scheduler.reportResult / EWMA feedback loop", () => {
  it("records error rate so a flapping account loses weight on next select", async () => {
    const group = await seedGroup();
    const acctA = await seedAccount({ name: "a", priority: 10 });
    const acctB = await seedAccount({ name: "b", priority: 10 });
    await attachToGroup(acctA.id, group.id, 10);
    await attachToGroup(acctB.id, group.id, 10);

    const stats = new AccountRuntimeStats({ alpha: 1, ttftFloorMs: 100 });
    const scheduler = buildScheduler({ stats });

    // Drive acctA into 100% error rate.
    for (let i = 0; i < 5; i++) scheduler.reportResult(acctA.id, false, 200);
    expect(stats.score(acctA.id).errorRate).toBe(1);

    // Even with a "favorable" random roll, weighted-random skips acctA when
    // its weight is 0.
    const random = () => 0.99;
    const fwd = createScheduler({
      db: db as never,
      stats,
      random,
    });
    const result = await fwd.select({
      orgId,
      teamId: null,
      groupId: group.id,
    });
    expect(result.account.id).toBe(acctB.id);
  });
});
