import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock ONLY the network-touching exchange/build, but PRESERVE the anthropic
// flag-gate (so Task 9's "anthropic disabled -> NOT_FOUND" test still holds)
// and emit a VALID 22-char base64url state (so Task 9's flowId regex holds).
vi.mock("@caliber/gateway-core/oauth", async (orig) => {
  const actual = await orig<typeof import("@caliber/gateway-core/oauth")>();
  return {
    ...actual,
    resolveOAuthService: (
      platform: "openai" | "anthropic",
      env: { ENABLE_ANTHROPIC_OAUTH: boolean },
    ) => {
      if (platform === "anthropic" && !env.ENABLE_ANTHROPIC_OAUTH) {
        throw new actual.OAuthServiceUnavailableError("anthropic");
      }
      return {
        platform,
        async generateAuthURL() {
          return {
            authUrl: "https://auth.openai.com/oauth/authorize?x=1",
            state: "AbCdEfGhIjKlMnOpQrStUv",
            codeVerifier: "verifier",
            redirectURI: "http://localhost:1455/auth/callback",
          };
        },
        async exchangeCode() {
          return {
            accessToken: "atk",
            refreshToken: "rtk",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          };
        },
      };
    },
  };
});

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

describe("accounts.completeOAuth (first-connect)", () => {
  it("exchanges the code and inserts a user-owned oauth upstream", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const init = await caller.accounts.initiateOAuth({ platform: "openai" });
    // mock generateAuthURL fixed state -> mirror it into the pasted URL
    const flowId = init.flowId;
    const pasted = `http://localhost:1455/auth/callback?code=THECODE&state=${flowId}`;
    const acct = await caller.accounts.completeOAuth({ flowId, pastedValue: pasted });
    expect(acct.type).toBe("oauth");
    expect(acct.userId).toBe(u.id);
    expect(acct.platform).toBe("openai");
    // flow-state consumed
    expect((redis as any).store.get(`oauth-flow:${flowId}`)).toBeUndefined();
    // row really exists
    const [row] = await t.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, acct.id));
    expect(row!.type).toBe("oauth");
  });

  it("rejects when state in pastedValue != flowId (CSRF / bare code)", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis();
    const caller = await callerFor({ db: t.db, userId: u.id, redis });
    const init = await caller.accounts.initiateOAuth({ platform: "openai" });
    await expect(caller.accounts.completeOAuth({ flowId: init.flowId, pastedValue: "http://localhost:1455/auth/callback?code=THECODE&state=WRONG" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("PRECONDITION_FAILED when flow expired/missing", async () => {
    const org = await makeOrg(t.db);
    const u = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: u.id, redis: fakeRedis() });
    await expect(caller.accounts.completeOAuth({ flowId: "nonexistent", pastedValue: "x#nonexistent" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("FORBIDDEN when another user submits someone else's flowId", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const b = await makeUser(t.db, { role: "member", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const redis = fakeRedis(); // shared so B can see A's flow-state
    const callerA = await callerFor({ db: t.db, userId: a.id, redis });
    const init = await callerA.accounts.initiateOAuth({ platform: "openai" });
    const callerB = await callerFor({ db: t.db, userId: b.id, redis });
    await expect(
      callerB.accounts.completeOAuth({ flowId: init.flowId, pastedValue: `x?code=C&state=${init.flowId}` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A's flow-state must remain (not griefed by B's attempt)
    expect((redis as any).store.get(`oauth-flow:${init.flowId}`)).toBeDefined();
  });
});
