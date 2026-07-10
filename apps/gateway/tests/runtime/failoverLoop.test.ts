import { describe, it, expect } from "vitest";
import { runFailover } from "../../src/runtime/failoverLoop.js";
import type {
  AccountScheduler,
  ScheduleRequest,
  ScheduleResult,
} from "../../src/runtime/scheduler.js";

// Minimal scheduler that records every select() request and always returns
// the same account, so we can assert what runFailover forwards. Mirrors the
// recordingScheduler() helper in failoverLoop.sticky.test.ts.
function recordingScheduler(): {
  scheduler: AccountScheduler;
  seen: ScheduleRequest[];
} {
  const seen: ScheduleRequest[] = [];
  const account = {
    id: "acct-pinned",
    concurrency: 10,
    platform: "anthropic",
    type: "api_key",
    rateMultiplier: "1.0000",
    priority: 50,
    groupId: null,
  };
  const result: ScheduleResult = {
    account,
    decision: {
      layer: "forced",
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
  const scheduler = {
    select: async (req: ScheduleRequest) => {
      seen.push(req);
      return result;
    },
    reportResult: () => {},
    reportSwitch: () => {},
    snapshotRuntimeStats: () => ({}) as never,
  } as AccountScheduler;
  return { scheduler, seen };
}

describe("runFailover — stickyAccountId forwarding to scheduler.select", () => {
  it("forwards stickyAccountId into the schedule request", async () => {
    const { scheduler, seen } = recordingScheduler();

    const out = await runFailover({
      db: {} as never,
      orgId: "org-1",
      teamId: null,
      groupId: null,
      routingPolicy: "own_then_pool" as const,
      userId: null,
      platform: "anthropic",
      authHealth: undefined,
      maxSwitches: 1,
      scheduler,
      stickyAccountId: "acct-pinned",
      attempt: async () => "done",
    });

    expect(out).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stickyAccountId).toBe("acct-pinned");
  });

  it("passes it through as undefined when the caller omits it", async () => {
    const { scheduler, seen } = recordingScheduler();

    await runFailover({
      db: {} as never,
      orgId: "org-1",
      teamId: null,
      platform: "anthropic",
      routingPolicy: "pool" as const,
      userId: null,
      maxSwitches: 1,
      scheduler,
      attempt: async () => "x",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.stickyAccountId).toBeUndefined();
  });
});
