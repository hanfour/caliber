import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import { upstreamAccounts } from "@caliber/db";
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory } from "../../../src/trpc/procedures.js";
import { appRouter } from "../../../src/trpc/router.js";

const createCaller = createCallerFactory(appRouter);

// Each caller gets its own ioredis-mock so authfail/authgrace assertions in
// one test can't leak into another. keyPrefix mirrors the real shared client
// so authFailKey/authGraceKey (bare) land under `caliber:gw:`.
function freshRedis(): Redis {
  return new RedisMock({ keyPrefix: "caliber:gw:" }) as unknown as Redis;
}

async function adminCallerFor(
  db: Database,
  userId: string,
  redis: Redis,
  env: ServerEnv = defaultTestEnv,
) {
  const perm = await resolvePermissions(db, userId);
  return createCaller({
    db,
    user: { id: userId, email: "admin@test.test" },
    perm,
    reqId: "test",
    locale: "en",
    env,
    redis,
    ipAddress: null,
    logger: noopTestLogger,
  });
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

// Seed an org_admin + an api_key account (with credential_vault, via create),
// then force the row into a degraded state. Returns the caller (bound to its
// own redis), the account id, and the redis client.
async function seedDegradedApiKeyAccount(opts: {
  reason: string;
}): Promise<{ caller: Awaited<ReturnType<typeof adminCallerFor>>; accountId: string; redis: Redis }> {
  const org = await makeOrg(t.db);
  const admin = await makeUser(t.db, {
    role: "org_admin",
    scopeType: "organization",
    scopeId: org.id,
    orgId: org.id,
  });
  const redis = freshRedis();
  const caller = await adminCallerFor(t.db, admin.id, redis);

  const acct = await caller.accounts.create({
    orgId: org.id,
    name: "degraded api_key",
    platform: "anthropic",
    type: "api_key",
    credentials: "sk-ant-original",
  });

  // Force the degraded state the gateway would set on a dead credential.
  await t.db
    .update(upstreamAccounts)
    .set({
      tempUnschedulableUntil: new Date(Date.now() + 60 * 60 * 1000),
      tempUnschedulableReason: opts.reason,
      errorMessage: "401 invalid x-api-key",
    })
    .where(eq(upstreamAccounts.id, acct.id));

  return { caller, accountId: acct.id, redis };
}

describe("accounts.rotate — api_key credential-health recovery", () => {
  it("rotate clears api_key-degraded temp fields, DELs authfail, SETs authgrace with TTL", async () => {
    const { caller, accountId, redis } = await seedDegradedApiKeyAccount({
      reason: "api_key_invalid_credential",
    });

    // Seed the auth-fail counter the gateway maintains for this account.
    await redis.set(authFailKey(accountId), "5");

    await caller.accounts.rotate({
      id: accountId,
      credentials: "sk-ant-rotated",
    });

    const [row] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, accountId));
    expect(row!.tempUnschedulableUntil).toBeNull();
    expect(row!.tempUnschedulableReason).toBeNull();
    expect(row!.errorMessage).toBeNull();

    // authfail counter removed.
    expect(await redis.get(authFailKey(accountId))).toBeNull();

    // authgrace set with a positive TTL (so in-flight OLD-credential requests
    // can't immediately re-degrade the freshly-rotated account).
    expect(await redis.get(authGraceKey(accountId))).toBe("1");
    const ttl = await redis.ttl(authGraceKey(accountId));
    expect(ttl).toBeGreaterThan(0);
  });

  it("rotate does NOT clear a pause set for a DIFFERENT reason (anti-stomp)", async () => {
    const { caller, accountId } = await seedDegradedApiKeyAccount({
      reason: "oauth_refresh_exhausted",
    });

    await caller.accounts.rotate({
      id: accountId,
      credentials: "sk-ant-rotated",
    });

    const [row] = await t.db
      .select()
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, accountId));
    // The non-api_key pause must survive an api_key rotate.
    expect(row!.tempUnschedulableUntil).not.toBeNull();
    expect(row!.tempUnschedulableReason).toBe("oauth_refresh_exhausted");
    expect(row!.errorMessage).toBe("401 invalid x-api-key");
  });
});
