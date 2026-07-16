import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Database } from "@caliber/db";
import {
  githubConnections,
  githubDeliveryReports,
  githubPullRequests,
  accounts,
} from "@caliber/db";
import { eq } from "drizzle-orm";
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
import {
  githubDeliveryRouter,
  type GithubSyncQueue,
  type GithubDeliveryQueue,
} from "../../../src/trpc/routers/githubDelivery.js";
import type { TrpcContext } from "../../../src/trpc/context.js";

// Local sub-router: isolated from the appRouter wiring under test elsewhere.
const localRouter = router({ githubDelivery: githubDeliveryRouter });
const createLocalCaller = createCallerFactory(localRouter);

type LocalCtx = TrpcContext & {
  githubSyncQueue?: GithubSyncQueue;
  githubDeliveryQueue?: GithubDeliveryQueue;
};

async function callerFor(opts: {
  db: Database;
  userId: string;
  email?: string;
  env?: ServerEnv;
  githubSyncQueue?: GithubSyncQueue;
  githubDeliveryQueue?: GithubDeliveryQueue;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  const ctx: LocalCtx = {
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    locale: "en",
    env: opts.env ?? defaultTestEnv,
    redis: defaultTestRedis,
    ipAddress: null,
    logger: noopTestLogger,
    githubSyncQueue: opts.githubSyncQueue,
    githubDeliveryQueue: opts.githubDeliveryQueue,
  };
  return createLocalCaller(ctx);
}

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  if (t) await t.stop();
});

const envWithFlag = { ...defaultTestEnv, ENABLE_GITHUB_DELIVERY: true };

const TOKEN = "github_pat_LIVETOKEN000000000000000";

const FROM = "2026-06-16T00:00:00.000Z";
const TO = "2026-07-16T00:00:00.000Z";

/** Probe fetch stub: /user ok, /orgs/.../repos ok with one repo. */
function stubProbeFetch(ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (!ok) return new Response("{}", { status: 401 });
      if (path === "/user") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify([{ full_name: "acme/web" }]), { status: 200 });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("githubDelivery router", () => {
  it("404s when the flag is off", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: admin.id, env: defaultTestEnv }); // flag off
    await expect(caller.githubDelivery.getConnection({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("FORBIDDEN for a plain member", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
    await expect(
      caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("setConnection probes, encrypts at rest, and never returns the token", async () => {
    stubProbeFetch(true);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });

    const res = await caller.githubDelivery.setConnection({
      orgId: org.id, ownerLogin: "acme", token: TOKEN, repoAllowlist: ["acme/web"],
    });
    expect(res).toEqual({ ownerLogin: "acme", tokenLast4: TOKEN.slice(-4), sampleRepo: "acme/web" });
    expect(JSON.stringify(res)).not.toContain(TOKEN);

    const row = (await t.db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id)))[0]!;
    expect(row.ciphertext.toString("utf8")).not.toContain(TOKEN); // encrypted at rest
    expect(row.tokenLast4).toBe(TOKEN.slice(-4));

    const got = await caller.githubDelivery.getConnection({ orgId: org.id });
    expect(got).toMatchObject({ ownerLogin: "acme", tokenLast4: TOKEN.slice(-4), status: "ok" });
    expect(JSON.stringify(got)).not.toContain(TOKEN);

    // Update path: same org, new token — row id (encryption salt) must be reused.
    const res2 = await caller.githubDelivery.setConnection({
      orgId: org.id, ownerLogin: "acme", token: `${TOKEN}X2`,
    });
    expect(res2.tokenLast4).toBe(`${TOKEN}X2`.slice(-4));
    const rows = await t.db.select().from(githubConnections).where(eq(githubConnections.orgId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(row.id);
  });

  it("rejects a bad token with BAD_REQUEST", async () => {
    stubProbeFetch(false);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
    await expect(
      caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("syncNow enqueues with a colon-free jobId; testMode without a queue", async () => {
    stubProbeFetch(true);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const added: Array<{ name: string; data: unknown; opts?: { jobId?: string } }> = [];
    const queue: GithubSyncQueue = { add: async (name, data, opts) => void added.push({ name, data, opts }) };

    const withQueue = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag, githubSyncQueue: queue });
    await withQueue.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });
    const res = await withQueue.githubDelivery.syncNow({ orgId: org.id });
    expect(res.enqueued).toBe(true);
    expect(added[0]!.opts?.jobId).not.toContain(":");
    expect(added[0]!.data).toEqual({ orgId: org.id, triggeredBy: "manual" });

    const noQueue = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
    expect(await noQueue.githubDelivery.syncNow({ orgId: org.id })).toMatchObject({ testMode: true });
  });

  it("deleteConnection removes the row; syncNow then 404s", async () => {
    stubProbeFetch(true);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
    await caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });
    expect(await caller.githubDelivery.deleteConnection({ orgId: org.id })).toEqual({ deleted: true });
    await expect(caller.githubDelivery.syncNow({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("generate: admin-gated, caps at 92 days, requires a connection, enqueues with regenerate semantics", async () => {
    stubProbeFetch(true);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const member = await makeUser(t.db, { orgId: org.id });

    const calls: string[] = [];
    const queue = {
      add: async (_n: string, data: unknown, opts?: { jobId?: string }) => void calls.push(`add:${(opts?.jobId ?? "")}`),
      remove: async (jobId: string) => void calls.push(`remove:${jobId}`),
    };
    const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag, githubDeliveryQueue: queue });

    // no connection yet → NOT_FOUND
    await expect(caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    await caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });

    // >92d → BAD_REQUEST
    await expect(caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: "2026-01-01T00:00:00.000Z", to: TO }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });

    const res = await caller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO });
    expect(res.enqueued).toBe(true);
    expect(calls[0]).toMatch(/^remove:ghdel_v1_/);          // regenerate = remove-before-add
    expect(calls[1]).toMatch(/^add:ghdel_v1_/);
    expect(res.jobId).not.toContain(":");

    // member (not admin) cannot generate
    const memberCaller = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
    await expect(memberCaller.githubDelivery.generate({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("generate: rejects a user who is not an org member with NOT_FOUND (anti-enumeration)", async () => {
    stubProbeFetch(true);
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    // No orgId passed — this user has no organizationMembers row for `org`.
    const outsider = await makeUser(t.db);

    const queue = {
      add: async () => {},
      remove: async () => {},
    };
    const caller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag, githubDeliveryQueue: queue });
    await caller.githubDelivery.setConnection({ orgId: org.id, ownerLogin: "acme", token: TOKEN });

    await expect(caller.githubDelivery.generate({ orgId: org.id, userId: outsider.id, from: FROM, to: TO }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getReport: self OR org_admin; returns latest overlapping row or null", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, { role: "org_admin", scopeType: "organization", scopeId: org.id, orgId: org.id });
    const member = await makeUser(t.db, { orgId: org.id });
    const stranger = await makeUser(t.db, { orgId: org.id });

    await t.db.insert(githubDeliveryReports).values({
      orgId: org.id, userId: member.id,
      periodStart: new Date(FROM), periodEnd: new Date(TO), periodType: "daily",
      totalScore: "88.5", insufficientData: false,
      sectionScores: [], metrics: { windowDays: 30 }, llmStatus: "skipped", triggeredBy: "manual",
    });

    const self = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
    const got = await self.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO });
    // total_score is numeric(10,4) — Postgres zero-pads on read regardless of
    // the inserted literal's precision (same behavior asserted for
    // evaluation_reports.total_score in reports.read.test.ts etc.).
    expect(got).toMatchObject({ totalScore: "88.5000", llmStatus: "skipped" });

    const adminCaller = await callerFor({ db: t.db, userId: admin.id, env: envWithFlag });
    expect(await adminCaller.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO })).not.toBeNull();

    // non-overlapping window → null
    expect(await self.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: "2025-01-01T00:00:00.000Z", to: "2025-02-01T00:00:00.000Z" })).toBeNull();

    // another member → FORBIDDEN
    const strangerCaller = await callerFor({ db: t.db, userId: stranger.id, env: envWithFlag });
    await expect(strangerCaller.githubDelivery.getReport({ orgId: org.id, userId: member.id, from: FROM, to: TO }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listActivity: returns display-safe activity for the member's github id; ghUserId null when unlinked", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });
    await t.db.insert(accounts).values({ userId: member.id, type: "oauth", provider: "github", providerAccountId: "777" });
    await t.db.insert(githubPullRequests).values({
      orgId: org.id, repoFullName: "acme/web", number: 1, ghNodeId: "PR_1",
      authorGhId: 777, authorLogin: "me", state: "closed", title: "t", htmlUrl: "u", baseRef: "main",
      ghCreatedAt: new Date("2026-07-01T00:00:00Z"), mergedAt: new Date("2026-07-02T00:00:00Z"),
    });

    const self = await callerFor({ db: t.db, userId: member.id, env: envWithFlag });
    const a = await self.githubDelivery.listActivity({ orgId: org.id, userId: member.id, from: FROM, to: TO });
    expect(a.ghUserId).toBe(777);
    expect(a.pulls).toHaveLength(1);
    expect(a.pulls[0]).toMatchObject({ repoFullName: "acme/web", number: 1, htmlUrl: "u" });

    const unlinked = await makeUser(t.db, { orgId: org.id });
    const u = await callerFor({ db: t.db, userId: unlinked.id, env: envWithFlag });
    const empty = await u.githubDelivery.listActivity({ orgId: org.id, userId: unlinked.id, from: FROM, to: TO });
    expect(empty.ghUserId).toBeNull();
    expect(empty.pulls).toEqual([]);
  });
});
