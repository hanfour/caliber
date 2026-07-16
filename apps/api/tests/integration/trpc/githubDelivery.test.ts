import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Database } from "@caliber/db";
import { githubConnections } from "@caliber/db";
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
} from "../../../src/trpc/routers/githubDelivery.js";
import type { TrpcContext } from "../../../src/trpc/context.js";

// Local sub-router: isolated from the appRouter wiring under test elsewhere.
const localRouter = router({ githubDelivery: githubDeliveryRouter });
const createLocalCaller = createCallerFactory(localRouter);

type LocalCtx = TrpcContext & { githubSyncQueue?: GithubSyncQueue };

async function callerFor(opts: {
  db: Database;
  userId: string;
  email?: string;
  env?: ServerEnv;
  githubSyncQueue?: GithubSyncQueue;
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
});
