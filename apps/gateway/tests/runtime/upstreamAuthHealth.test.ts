import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { recordAuthFailure, clearAuthFailure } from "../../src/runtime/upstreamAuthHealth.js";

// ioredis-mock shares one in-memory keyspace across `new RedisMock()` instances
// in a process, so counters leak between tests; flush before each.
const flushClient = new RedisMock() as unknown as Redis;
beforeEach(async () => {
  await flushClient.flushall();
});

const acct = (over: Partial<{ id: string; type: string; platform: string }> = {}) =>
  ({ id: "a1", type: "api_key", platform: "anthropic", ...over }) as never;

function fakeDb(rowCount = 1) {
  const where = vi.fn(() => ({ returning: vi.fn(async () => Array.from({ length: rowCount }, () => ({ id: "a1" }))) }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as never, update, set, where };
}
function deps(over: Partial<Record<string, unknown>> = {}) {
  const redis = new RedisMock() as unknown as Redis;
  const f = fakeDb();
  const base = {
    redis,
    db: f.db,
    f,
    maxFail: 3,
    backoffSec: 3600,
    graceSec: 120,
    metrics: { authFailedTotal: { inc: vi.fn() }, credentialDegradedTotal: { inc: vi.fn() } },
    logger: { warn: vi.fn() },
  };
  return { ...base, ...over } as typeof base;
}

describe("recordAuthFailure", () => {
  it("ignores non-401 (403) — no incr, no degrade", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 403);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("ignores oauth accounts", async () => {
    const d = deps();
    await recordAuthFailure(d, acct({ type: "oauth" }), 401);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
  });
  it("counts a 401 but does not degrade below threshold", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.authFailedTotal.inc).toHaveBeenCalledWith({ platform: "anthropic" });
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("degrades on the Nth 401 and counts the transition once", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 401);
    await recordAuthFailure(d, acct(), 401);
    await recordAuthFailure(d, acct(), 401); // n === 3 === maxFail
    expect(d.f.update).toHaveBeenCalledTimes(1);
    expect(d.metrics.credentialDegradedTotal.inc).toHaveBeenCalledTimes(1);
  });
  it("skips entirely while a grace key is present", async () => {
    const d = deps();
    await d.redis.set("authgrace:a1", "1");
    for (let i = 0; i < 5; i++) await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("does not count the degraded transition when the DB write affected 0 rows", async () => {
    const f = fakeDb(0);
    const d = deps({ db: f.db, f });
    for (let i = 0; i < 3; i++) await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.credentialDegradedTotal.inc).not.toHaveBeenCalled();
  });
  it("never throws when redis errors", async () => {
    const redis = { exists: vi.fn().mockRejectedValue(new Error("down")) } as never;
    const d = deps({ redis });
    await expect(recordAuthFailure(d, acct(), 401)).resolves.toBeUndefined();
  });
});

describe("clearAuthFailure", () => {
  it("DELs the counter and issues a reason-gated recover update", async () => {
    const d = deps();
    await d.redis.set("authfail:a1", "2");
    await clearAuthFailure(d, acct());
    expect(await d.redis.get("authfail:a1")).toBeNull();
    expect(d.f.update).toHaveBeenCalledTimes(1); // recover
  });
  it("never throws when db errors", async () => {
    const f = fakeDb();
    f.where.mockImplementation(() => { throw new Error("db down"); });
    const d = deps({ db: f.db, f });
    await expect(clearAuthFailure(d, acct())).resolves.toBeUndefined();
  });
});
