import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { apiKeys, accountGroups } from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { apiKeysRouter } from "../../../src/trpc/routers/apiKeys.js";

// Local sub-router so this test runs independently of the global appRouter.
const localRouter = router({ apiKeys: apiKeysRouter });
const createLocalCaller = createCallerFactory(localRouter);

let t: Awaited<ReturnType<typeof setupTestDb>>;
let redis: Redis;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

/**
 * Seed a member user with a fresh org and return a tRPC caller.
 */
async function memberCaller() {
  const org = await makeOrg(t.db);
  const user = await makeUser(t.db, {
    role: "member",
    scopeType: "organization",
    scopeId: org.id,
    orgId: org.id,
  });
  redis = new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
  const perm = await resolvePermissions(t.db, user.id);
  const caller = createLocalCaller({
    db: t.db,
    user: { id: user.id, email: "test@test.com" },
    perm,
    reqId: "test",
    locale: "en",
    env: defaultTestEnv,
    redis,
    ipAddress: null,
    logger: noopTestLogger,
  });
  return { caller, user, org, db: t.db };
}

/**
 * Insert an account_groups row for the given org and return its id.
 * Mirrors the makeGroup helper used in apiKeys.test.ts.
 */
async function makeGroup(orgId: string, platform = "openai") {
  const [g] = await t.db
    .insert(accountGroups)
    .values({ orgId, name: `grp-${Math.random().toString(36).slice(2, 8)}`, platform })
    .returning({ id: accountGroups.id });
  return g!.id;
}

describe("apiKeys.issueOwn — routingPolicy", () => {
  it("issueOwn defaults routing_policy to pool", async () => {
    const a = await memberCaller();
    const { id } = await a.caller.apiKeys.issueOwn({ name: "k" });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row!.routingPolicy).toBe("pool");
  });

  it("issueOwn persists routingPolicy 'own'", async () => {
    const a = await memberCaller();
    const { id } = await a.caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own" });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row!.routingPolicy).toBe("own");
  });

  it("issueOwn rejects a non-pool policy combined with a groupId", async () => {
    const a = await memberCaller();
    const groupId = await makeGroup(a.org.id);
    await expect(
      a.caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own", groupId }),
    ).rejects.toThrow(/mutually exclusive|group/i);
  });

  it("persists routingPolicy 'own_then_pool'", async () => {
    const a = await memberCaller();
    const { id } = await a.caller.apiKeys.issueOwn({ name: "k", routingPolicy: "own_then_pool" });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row!.routingPolicy).toBe("own_then_pool");
  });

  it("allows pool + groupId (existing #191 behaviour) and persists both", async () => {
    const a = await memberCaller();
    const groupId = await makeGroup(a.org.id);
    const { id } = await a.caller.apiKeys.issueOwn({ name: "k", routingPolicy: "pool", groupId });
    const [row] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row!.routingPolicy).toBe("pool");
    expect(row!.groupId).toBe(groupId);
  });
});
