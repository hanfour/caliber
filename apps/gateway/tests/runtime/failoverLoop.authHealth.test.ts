// Task 7 — the failover loop is the single choke point for api_key
// credential-health bookkeeping. On a successful attempt return it must call
// `clearAuthFailure` (reset the 401 counter + recover an account we degraded);
// on the classifier's `auth_invalid` result (401/403) in the switch_account
// branch it must call `recordAuthFailure` (threshold-degrade) before failing
// over. Both hooks are GUARDED by `if (input.authHealth)`, so loop-mechanics
// tests that omit `authHealth` (e.g. failoverLoop.sticky.test.ts) keep working.

import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { authFailKey } from "@caliber/gateway-core/redis";
import { runFailover } from "../../src/runtime/failoverLoop.js";
import type {
  AccountScheduler,
  ScheduleRequest,
  ScheduleResult,
  ScheduledAccount,
} from "../../src/runtime/scheduler.js";
import type { AuthHealthLoopDeps } from "../../src/runtime/upstreamAuthHealth.js";

// A scheduler that returns each provided account once, in order. `release` and
// `reportResult`/`reportSwitch` are no-ops so the loop's bookkeeping runs.
function queueScheduler(accounts: ScheduledAccount[]): AccountScheduler {
  let i = 0;
  return {
    select: async (_req: ScheduleRequest): Promise<ScheduleResult> => {
      const account = accounts[i++];
      if (!account) throw new Error("queueScheduler exhausted");
      return {
        account,
        decision: {
          layer: "load_balance",
          stickyHit: false,
          candidateCount: 1,
          selectedAccountId: account.id,
          selectedAccountType: account.type,
          platform: account.platform,
          loadSkew: 0,
          latencyMs: 0,
        },
        release: async () => {},
      };
    },
    reportResult: () => {},
    reportSwitch: () => {},
    snapshotRuntimeStats: () => ({}) as never,
  } as AccountScheduler;
}

// Minimal Drizzle-shaped fake: `.update().set().where()` resolves (clear path)
// and `.where().returning()` resolves to one row (record threshold path).
function fakeDb(): { db: unknown; updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          const whereResult = {
            returning: async () => [{ id: "acct-1" }],
            then: (res: (v: unknown) => void) => res(undefined),
          };
          return { where: () => whereResult };
        },
      };
    },
  };
  return { db, updates };
}

function authHealthDeps(redis: InstanceType<typeof RedisMock>): {
  deps: AuthHealthLoopDeps;
  authFailedTotal: { inc: ReturnType<typeof vi.fn> };
  credentialDegradedTotal: { inc: ReturnType<typeof vi.fn> };
} {
  const authFailedTotal = { inc: vi.fn() };
  const credentialDegradedTotal = { inc: vi.fn() };
  const deps: AuthHealthLoopDeps = {
    redis: redis as never,
    maxFail: 3,
    backoffSec: 3600,
    graceSec: 120,
    metrics: { authFailedTotal, credentialDegradedTotal },
    logger: { warn: () => {} },
  };
  return { deps, authFailedTotal, credentialDegradedTotal };
}

const apiKeyAccount = (id: string): ScheduledAccount => ({
  id,
  concurrency: 5,
  platform: "anthropic",
  type: "api_key",
  priority: 0,
  groupId: null,
});

describe("runFailover — api_key credential-health hooks", () => {
  it("clears the auth-failure counter on a successful attempt return", async () => {
    const redis = new RedisMock();
    const { db } = fakeDb();
    const { deps } = authHealthDeps(redis);

    // Seed a stale counter so we can prove clearAuthFailure DEL'd it.
    await redis.set(authFailKey("acct-1"), "2");
    expect(await redis.get(authFailKey("acct-1"))).toBe("2");

    const out = await runFailover({
      db: db as never,
      orgId: "org-1",
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 3,
      scheduler: queueScheduler([apiKeyAccount("acct-1")]),
      authHealth: deps,
      attempt: async (acct) => `ok:${acct.id}`,
    });

    expect(out).toBe("ok:acct-1");
    // counter DEL'd by clearAuthFailure
    expect(await redis.get(authFailKey("acct-1"))).toBeNull();
  });

  it("records an auth failure on a 401 switch_account, then fails over to the next account", async () => {
    const redis = new RedisMock();
    const { db } = fakeDb();
    const { deps, authFailedTotal } = authHealthDeps(redis);

    let calls = 0;
    const out = await runFailover({
      db: db as never,
      orgId: "org-1",
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 3,
      scheduler: queueScheduler([
        apiKeyAccount("acct-1"),
        apiKeyAccount("acct-2"),
      ]),
      authHealth: deps,
      attempt: async (acct) => {
        calls++;
        if (acct.id === "acct-1") {
          throw { status: 401, message: "invalid x-api-key" };
        }
        return `ok:${acct.id}`;
      },
    });

    expect(out).toBe("ok:acct-2");
    expect(calls).toBe(2);
    // recordAuthFailure ran for the 401'd account (counter incremented + metric)
    expect(authFailedTotal.inc).toHaveBeenCalledWith({ platform: "anthropic" });
    expect(await redis.get(authFailKey("acct-1"))).toBe("1");
  });
});
