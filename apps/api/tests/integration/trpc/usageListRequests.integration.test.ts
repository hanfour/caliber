/**
 * Integration tests for `usage.listRequests` (Task 9, single-request-replay).
 *
 * This procedure is the request PICKER that powers the replay UI (Task 10):
 * an operator browses a member's captured requests and chooses one to
 * replay. Unlike the aggregate scoring queries (which read
 * `usage_logs_scored` to keep replay traffic out of anyone's performance
 * numbers), this list deliberately reads the RAW `usage_logs` table —
 * replay rows are legitimate history the operator must be able to see, and
 * this is not a scoring surface. A query that silently switched to the
 * scored view would hide every past replay from the list.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "@caliber/db";
import { apiKeys, upstreamAccounts, usageLogs, requestBodies } from "@caliber/db";
import { resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
  defaultTestRedis,
  noopTestLogger,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { usageRouter } from "../../../src/trpc/routers/usage.js";

// Local sub-router, matching usage.test.ts's convention — this procedure
// lives entirely inside usageRouter and needs nothing else mounted.
const localRouter = router({ usage: usageRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: {
  db: Database;
  userId: string;
  email?: string;
  env?: ServerEnv;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: defaultTestRedis,
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

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;

async function seedApiKey(
  db: Database,
  opts: { userId: string; orgId: string },
): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      keyHash: `hash-listreq-${seedCounter}`,
      keyPrefix: "ak_test",
      name: `listreq-key-${seedCounter}`,
    })
    .returning({ id: apiKeys.id });
  return row!.id;
}

async function seedAccount(db: Database, orgId: string): Promise<string> {
  seedCounter += 1;
  const [row] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: `listreq-acct-${seedCounter}`,
      platform: "anthropic",
      type: "api_key",
    })
    .returning({ id: upstreamAccounts.id });
  return row!.id;
}

interface SeedRequestOpts {
  orgId: string;
  userId: string;
  apiKeyId: string;
  accountId: string;
  createdAt?: Date;
  actualCostUsd?: string;
  statusCode?: number;
  replayOfRequestId?: string | null;
  /** Set false to omit the request_bodies row entirely (retention expired). */
  withBody?: boolean;
  bodyTruncated?: boolean;
  toolResultTruncated?: boolean;
  stopReason?: string | null;
}

/**
 * Insert one `usage_logs` row plus (unless `withBody: false`) its captured
 * `request_bodies` row. Mirrors replay.integration.test.ts's
 * `seedCapturedRequest` — the closest existing model for this join.
 */
async function seedRequest(db: Database, opts: SeedRequestOpts): Promise<string> {
  const requestId = randomUUID();
  await db.insert(usageLogs).values({
    requestId,
    userId: opts.userId,
    apiKeyId: opts.apiKeyId,
    accountId: opts.accountId,
    orgId: opts.orgId,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 3,
    totalCost: "0.0030000000",
    actualCostUsd: opts.actualCostUsd ?? "0.0030000000",
    stream: false,
    statusCode: opts.statusCode ?? 200,
    durationMs: 150,
    replayOfRequestId: opts.replayOfRequestId ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });

  if (opts.withBody !== false) {
    const dummy = Buffer.from("sealed");
    await db.insert(requestBodies).values({
      requestId,
      orgId: opts.orgId,
      requestBodySealed: dummy,
      responseBodySealed: dummy,
      stopReason: opts.stopReason ?? "end_turn",
      bodyTruncated: opts.bodyTruncated ?? false,
      toolResultTruncated: opts.toolResultTruncated ?? false,
      retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  return requestId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("usage.listRequests", () => {
  it("returns a fully-populated row (bodyTruncated/hasBody) so the UI can decide the replay button's state", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const requestId = await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
      bodyTruncated: false,
      stopReason: "end_turn",
      actualCostUsd: "0.0042000000",
    });

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const { rows, nextCursor } = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
    });

    expect(rows).toHaveLength(1);
    expect(nextCursor).toBeNull();
    expect(rows[0]).toMatchObject({
      requestId,
      requestedModel: "claude-sonnet-4-5",
      upstreamModel: "claude-sonnet-4-5-20250101",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      totalCost: "0.0042000000",
      statusCode: 200,
      durationMs: 150,
      stopReason: "end_turn",
      bodyTruncated: false,
      toolResultTruncated: false,
      hasBody: true,
      replayOfRequestId: null,
    });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("a row whose retention already expired (request_bodies gone) reports hasBody: false", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const expiredId = await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
      withBody: false,
    });

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const { rows } = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
    });

    const row = rows.find((r) => r.requestId === expiredId);
    expect(row).toBeDefined();
    expect(row!.hasBody).toBe(false);
    // No captured body → the truncation flags default to "not truncated",
    // distinct from hasBody: false. The UI checks both signals separately.
    expect(row!.bodyTruncated).toBe(false);
    expect(row!.toolResultTruncated).toBe(false);
    expect(row!.stopReason).toBeNull();
  });

  it("replay rows are marked by replayOfRequestId and are NOT hidden from the list", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const sourceId = await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
    });
    const replayId = await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
      replayOfRequestId: sourceId,
    });

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const { rows } = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
    });

    // Both rows present — a query that silently read usage_logs_scored
    // would drop the replay row and this would fail with length 1.
    expect(rows).toHaveLength(2);
    const replayRow = rows.find((r) => r.requestId === replayId);
    expect(replayRow?.replayOfRequestId).toBe(sourceId);
    const sourceRow = rows.find((r) => r.requestId === sourceId);
    expect(sourceRow?.replayOfRequestId).toBeNull();
  });

  it("a caller who is neither the request author nor an org_admin → FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const otherMember = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: otherMember.id });

    await expect(
      caller.usage.listRequests({ orgId: org.id, userId: owner.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an org_admin may list another member's requests", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
    });

    const caller = await callerFor({ db: t.db, userId: admin.id });
    const { rows } = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
    });
    expect(rows).toHaveLength(1);
  });

  it("cursor pagination: a full first page returns a cursor; the second page exhausts with cursor null", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    const base = Date.now() - 60_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await seedRequest(t.db, {
          orgId: org.id,
          userId: owner.id,
          apiKeyId: key,
          accountId: account,
          createdAt: new Date(base + i * 1000),
        }),
      );
    }
    // ids[4] has the latest createdAt, so DESC order puts it first.

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const page1 = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
      limit: 3,
    });
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.rows.map((r) => r.requestId)).toEqual([ids[4], ids[3], ids[2]]);

    const page2 = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.rows).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(page2.rows.map((r) => r.requestId)).toEqual([ids[1], ids[0]]);
  });

  it("exactly `limit` rows in the window: no phantom next page", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });
    const base = Date.now() - 60_000;
    for (let i = 0; i < 3; i += 1) {
      await seedRequest(t.db, {
        orgId: org.id,
        userId: owner.id,
        apiKeyId: key,
        accountId: account,
        createdAt: new Date(base + i * 1000),
      });
    }

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const page = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
      limit: 3,
    });
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("from/to window filters out rows outside the range", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const account = await seedAccount(t.db, org.id);
    const key = await seedApiKey(t.db, { userId: owner.id, orgId: org.id });

    await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });
    const recentId = await seedRequest(t.db, {
      orgId: org.id,
      userId: owner.id,
      apiKeyId: key,
      accountId: account,
      createdAt: new Date("2026-04-15T00:00:00Z"),
    });

    const caller = await callerFor({ db: t.db, userId: owner.id });
    const { rows } = await caller.usage.listRequests({
      orgId: org.id,
      userId: owner.id,
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe(recentId);
  });

  it("ENABLE_GATEWAY=false → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const owner = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({
      db: t.db,
      userId: owner.id,
      env: { ...defaultTestEnv, ENABLE_GATEWAY: false },
    });
    await expect(
      caller.usage.listRequests({ orgId: org.id, userId: owner.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
