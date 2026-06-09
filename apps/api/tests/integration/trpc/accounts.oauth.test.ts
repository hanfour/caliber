import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { upstreamAccounts } from "@caliber/db";
import { eq } from "drizzle-orm";
import { resolvePermissions } from "@caliber/auth";
import {
  setupTestDb, makeOrg, makeUser, defaultTestEnv, noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { accountsRouter } from "../../../src/trpc/routers/accounts.js";

// Minimal ioredis-shaped fake. Captures the full set() args (incl. "EX",600)
// so a test can assert the TTL is actually passed.
function fakeRedis() {
  const m = new Map<string, string>();
  const setArgs: unknown[][] = [];
  return {
    store: m,
    setArgs,
    async set(k: string, v: string, ...rest: unknown[]) {
      setArgs.push([k, v, ...rest]);
      m.set(k, v);
      return "OK";
    },
    async get(k: string) { return m.get(k) ?? null; },
    async del(k: string) { return m.delete(k) ? 1 : 0; },
  } as unknown as import("ioredis").Redis;
}

const localRouter = router({ accounts: accountsRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: { db: any; userId: string; redis: any; env?: any }) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db, user: { id: opts.userId, email: "x@x.test" }, perm,
    reqId: "test", locale: "en", env: opts.env ?? defaultTestEnv,
    redis: opts.redis, ipAddress: null, logger: noopTestLogger,
  });
}

let t: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => { t = await setupTestDb(); });
afterAll(async () => { await t.stop(); });

describe("accounts.initiateOAuth", () => {
  it("openai: stores flow-state in redis and returns an auth URL", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const res = await caller.accounts.initiateOAuth({ platform: "openai" });
    expect(res.authUrl).toContain("auth.openai.com/oauth/authorize");
    expect(res.flowId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = JSON.parse((redis as any).store.get(`oauth-flow:${res.flowId}`));
    expect(stored).toMatchObject({ userId: u.id, platform: "openai", targetUpstreamId: null });
    expect(typeof stored.codeVerifier).toBe("string");
    expect(typeof stored.redirectURI).toBe("string");
    // flow-state must carry a 10-minute TTL
    expect((redis as any).setArgs[0].slice(2)).toEqual(["EX", 600]);
  });

  it("anthropic: NOT_FOUND when ENABLE_ANTHROPIC_OAUTH is off", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, redis: fakeRedis(), env: { ...defaultTestEnv, ENABLE_ANTHROPIC_OAUTH: false } });
    await expect(caller.accounts.initiateOAuth({ platform: "anthropic" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("re-auth targeting another user's upstream returns NOT_FOUND (no existence leak)", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const other = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    // owner registers an oauth upstream directly
    const [row] = await t.db
      .insert(upstreamAccounts)
      .values({ orgId: org.id, userId: owner.id, teamId: null, name: "owned", platform: "openai", type: "oauth" })
      .returning();
    const caller = await callerFor({ db: t.db, userId: other.id, redis: fakeRedis() });
    await expect(
      caller.accounts.initiateOAuth({ platform: "openai", targetUpstreamId: row!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
