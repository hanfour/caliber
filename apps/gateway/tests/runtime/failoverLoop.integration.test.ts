import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
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
import {
  organizations,
  upstreamAccounts,
  accountGroups,
  accountGroupMembers,
} from "@caliber/db";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
  RateLimitedError,
} from "../../src/runtime/failoverLoop.js";

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
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "failover-test-org", name: "Failover Test Org" })
    .returning();
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(upstreamAccounts);
});

const baseAccount = {
  orgId: "",
  teamId: null as string | null,
  platform: "anthropic" as const,
  type: "api_key" as const,
  schedulable: true,
  status: "active" as const,
};

describe("runFailover", () => {
  it("returns first attempt's result on success (happy path)", async () => {
    const [acct] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const attempt = vi.fn().mockResolvedValue("ok");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(out).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]![0].id).toBe(acct!.id);
  });

  it("first account 429 → rateLimitedAt set → second account succeeds", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const [acctB] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 })
      .returning();

    const attempt = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject({ status: 429, retryAfter: 60 }),
      )
      .mockResolvedValueOnce("result-b");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(out).toBe("result-b");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[1]![0].id).toBe(acctB!.id);

    const [row] = await db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acctA!.id));
    expect(row!.rateLimitedAt).not.toBeNull();
    expect(row!.rateLimitResetAt).not.toBeNull();
    // resetAt should be approximately now + 60s
    const resetAt = row!.rateLimitResetAt!.getTime();
    expect(resetAt).toBeGreaterThan(Date.now() + 50_000);
    expect(resetAt).toBeLessThan(Date.now() + 70_000);
  });

  it("ALL accounts 429 → throws RateLimitedError (not AllUpstreamsFailed) with soonest retry-after", async () => {
    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "rl-a", priority: 1 });
    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "rl-b", priority: 2 });

    // Every attempt is rate-limited. With no non-429 failure the loop must
    // collapse to a transient RateLimitedError → routes map it to 429+Retry-After.
    const attempt = vi.fn().mockRejectedValue({ status: 429, retryAfter: 60 });

    let caught: unknown;
    try {
      await runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 10,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(caught).not.toBeInstanceOf(AllUpstreamsFailed);
    // soonest reset ≈ now + 60s → retryAfterSec in (50, 60]
    const sec = (caught as RateLimitedError).retryAfterSec;
    expect(sec).toBeGreaterThan(50);
    expect(sec).toBeLessThanOrEqual(60);
  });

  it("mixed 429 + 401 (auth_invalid) → AllUpstreamsFailed, NOT RateLimitedError", async () => {
    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "mix-a", priority: 1 });
    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "mix-b", priority: 2 });

    // One 429 (rate-limited) + one 401 (auth_invalid). A non-rate-limit failure
    // is present, so retrying-after-a-bit won't fix it → stay generic 503.
    const attempt = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, retryAfter: 60 })
      .mockRejectedValueOnce({ status: 401, message: "unauthorized" });

    let caught: unknown;
    try {
      await runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 10,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AllUpstreamsFailed);
    expect(caught).not.toBeInstanceOf(RateLimitedError);
  });

  it("upstream ALREADY rate-limited (scheduler pre-excludes it) → RateLimitedError via probe, attempt never called", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    await db.insert(upstreamAccounts).values({
      ...baseAccount,
      orgId,
      name: "prerl-a",
      priority: 1,
      rateLimitedAt: new Date(),
      rateLimitResetAt: resetAt,
    });

    // Account is inside its rate-limit window → the scheduler excludes it →
    // NoSchedulableAccountsError. The path-2 probe must recognise this as a
    // rate-limit (429 + Retry-After), NOT a generic all_upstreams_failed (503).
    const attempt = vi.fn();

    let caught: unknown;
    try {
      await runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 10,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(attempt).not.toHaveBeenCalled();
    const sec = (caught as RateLimitedError).retryAfterSec;
    expect(sec).toBeGreaterThan(50);
    expect(sec).toBeLessThanOrEqual(60);
  });

  it("first connection error → retry succeeds same account → sleep called once", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const attempt = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
      )
      .mockResolvedValueOnce("ok-retry");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: sleepFn,
    });

    expect(out).toBe("ok-retry");
    // Both calls are to the same account
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[0]![0].id).toBe(acctA!.id);
    expect(attempt.mock.calls[1]![0].id).toBe(acctA!.id);
    // sleep called once with 500ms backoff
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(500);
  });

  it("all 3 retries on same account fail (ECONNREFUSED) → switches to second account, sleep called 3 times, no state update on first", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const [acctB] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 })
      .returning();

    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const attempt = vi
      .fn()
      .mockImplementation((acct: { id: string }) => {
        if (acct.id === acctA!.id) {
          return Promise.reject(
            Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
          );
        }
        return Promise.resolve("result-b");
      });

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: sleepFn,
    });

    expect(out).toBe("result-b");
    // 4 calls for acctA (retry 0,1,2,3 — retries 0-2 get sleep, retry 3 breaks) + 1 for acctB
    expect(attempt).toHaveBeenCalledTimes(5);
    expect(sleepFn).toHaveBeenCalledTimes(3);

    // First account should NOT have state update (connection errors don't update state)
    const [rowA] = await db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acctA!.id));
    expect(rowA!.rateLimitedAt).toBeNull();
    expect(rowA!.overloadUntil).toBeNull();
    expect(rowA!.tempUnschedulableUntil).toBeNull();
    expect(rowA!.status).toBe("active");
  });

  it("first account 401 → fails over (NO state mutation; recoverable credential-health owns the degrade) → second account succeeds", async () => {
    // Credential-health change: a 401 is classified `auth_invalid` with NO
    // `stateUpdate` — the account is NOT hard-flipped to `status='error'`. The
    // recoverable degrade (temp-unschedulable + counter) lives in the failover
    // loop's `authHealth` hook (recordAuthFailure), which is absent on this
    // hand-built input, so here a 401 is a pure in-memory failover (mirrors the
    // connection-error case above): acctA stays `active`, no error fields.
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const [acctB] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 })
      .returning();

    const attempt = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject({ status: 401 }))
      .mockResolvedValueOnce("result-b");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(out).toBe("result-b");
    expect(attempt.mock.calls[1]![0].id).toBe(acctB!.id);

    const [rowA] = await db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acctA!.id));
    // 401 no longer hard-errors the account — it stays active + clean so the
    // recoverable credential-health path can own pause/recover instead.
    expect(rowA!.status).toBe("active");
    expect(rowA!.errorMessage).toBeNull();
    expect(rowA!.tempUnschedulableUntil).toBeNull();
    expect(rowA!.tempUnschedulableReason).toBeNull();
  });

  it("first account 529 (overloaded) → overloadUntil set → second account succeeds", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 });

    const attempt = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject({ status: 529 }))
      .mockResolvedValueOnce("result-b");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(out).toBe("result-b");

    const [rowA] = await db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acctA!.id));
    expect(rowA!.overloadUntil).not.toBeNull();
    const overloadUntil = rowA!.overloadUntil!.getTime();
    expect(overloadUntil).toBeGreaterThan(Date.now() + 50_000);
    expect(overloadUntil).toBeLessThan(Date.now() + 70_000);
  });

  it("first account 503 → tempUnschedulableUntil set with reason upstream_503 → second succeeds", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 });

    const attempt = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject({ status: 503, message: "server down" }),
      )
      .mockResolvedValueOnce("result-b");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 10,
      attempt,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(out).toBe("result-b");

    const [rowA] = await db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acctA!.id));
    expect(rowA!.tempUnschedulableUntil).not.toBeNull();
    expect(rowA!.tempUnschedulableReason).toBe("upstream_503");
  });

  it("all accounts fail with switchable errors → throws AllUpstreamsFailed", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    const [acctB] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 })
      .returning();

    // 503 is a switchable error that is NOT a rate-limit, so the terminal stays
    // AllUpstreamsFailed. (The all-429 case now yields RateLimitedError — covered
    // by the dedicated "ALL accounts 429" test above.)
    const attempt = vi.fn().mockRejectedValue({ status: 503 });

    await expect(
      runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 10,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as AllUpstreamsFailed;
      expect(e).toBeInstanceOf(AllUpstreamsFailed);
      expect(e.attemptedIds).toContain(acctA!.id);
      expect(e.attemptedIds).toContain(acctB!.id);
      return true;
    });
  });

  it("fatal 4xx error short-circuits — does NOT switch to other accounts", async () => {
    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 });

    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 });

    const attempt = vi
      .fn()
      .mockRejectedValue({ status: 400 });

    await expect(
      runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 10,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as FatalUpstreamError;
      expect(e).toBeInstanceOf(FatalUpstreamError);
      expect(e.statusCode).toBe(400);
      expect(e.reason).toBe("client_error");
      return true;
    });

    // Only called once — no second attempt
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("maxSwitches=1 + first fails → AllUpstreamsFailed even if second exists", async () => {
    const [acctA] = await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-a", priority: 1 })
      .returning();

    await db
      .insert(upstreamAccounts)
      .values({ ...baseAccount, orgId, name: "acct-b", priority: 2 });

    const attempt = vi
      .fn()
      .mockRejectedValue({ status: 429, retryAfter: 60 });

    await expect(
      runFailover({
        db: db as never,
        orgId,
        teamId: null,
        platform: "anthropic",
        routingPolicy: "pool" as const,
        userId: null,
        maxSwitches: 1,
        attempt,
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as AllUpstreamsFailed;
      expect(e).toBeInstanceOf(AllUpstreamsFailed);
      expect(e.attemptedIds).toEqual([acctA!.id]);
      return true;
    });

    // Only one attempt made (maxSwitches=1 means only one outer iteration)
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  // Regression for #81 — pre-fix runFailover dropped the api-key's
  // groupId before reaching the scheduler, so an org with mixed-platform
  // accounts (Anthropic OAuth + OpenAI api_key) would silently route a
  // /v1/messages call to whichever upstream the legacy fallback picked
  // first, often the wrong-platform one.
  it("regression #81: forwards groupId so scheduler filters by platform", async () => {
    const [anthrAcct] = await db
      .insert(upstreamAccounts)
      .values({
        ...baseAccount,
        orgId,
        name: "anthr-oauth",
        platform: "anthropic",
        type: "oauth",
        priority: 50,
      })
      .returning();
    const [openaiAcct] = await db
      .insert(upstreamAccounts)
      .values({
        ...baseAccount,
        orgId,
        name: "openai-key",
        platform: "openai",
        type: "api_key",
        priority: 50,
      })
      .returning();

    const [grp] = await db
      .insert(accountGroups)
      .values({ orgId, name: "anthropic-only", platform: "anthropic" })
      .returning();
    await db
      .insert(accountGroupMembers)
      .values({ accountId: anthrAcct!.id, groupId: grp!.id });

    const seenAccountIds: string[] = [];
    const attempt = vi.fn().mockImplementation(async (account) => {
      seenAccountIds.push(account.id);
      return "ok";
    });

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      groupId: grp!.id,
      maxSwitches: 5,
      attempt,
    });

    expect(out).toBe("ok");
    expect(seenAccountIds).toEqual([anthrAcct!.id]);
    expect(seenAccountIds).not.toContain(openaiAcct!.id);
  });

  it("regression #81: groupId omitted preserves legacy org-wide path", async () => {
    await db
      .insert(upstreamAccounts)
      .values({
        ...baseAccount,
        orgId,
        name: "legacy-anthropic",
        platform: "anthropic",
        type: "oauth",
        priority: 1,
      });

    const attempt = vi.fn().mockResolvedValue("legacy-ok");

    const out = await runFailover({
      db: db as never,
      orgId,
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      // groupId omitted on purpose
      maxSwitches: 5,
      attempt,
    });

    expect(out).toBe("legacy-ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
