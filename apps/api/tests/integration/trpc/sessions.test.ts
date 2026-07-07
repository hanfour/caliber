import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import { clientEvents, clientSessions, devices } from "@caliber/db";
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
import { sessionsRouter } from "../../../src/trpc/routers/sessions.js";

const localRouter = router({ sessions: sessionsRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: {
  db: Database;
  userId: string;
  env?: ServerEnv;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db,
    user: { id: opts.userId, email: "x@x.test" },
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

beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE TABLE client_events RESTART IDENTITY CASCADE`);
  await t.db.execute(sql`TRUNCATE TABLE client_sessions RESTART IDENTITY CASCADE`);
  await t.db.execute(sql`TRUNCATE TABLE devices RESTART IDENTITY CASCADE`);
});

async function seedSession(
  db: Database,
  opts: {
    userId: string;
    orgId: string;
    sessionId: string;
    sourceClient?: string;
    startedAt: Date;
    events: number;
  },
): Promise<void> {
  const [device] = await db
    .insert(devices)
    .values({
      userId: opts.userId,
      orgId: opts.orgId,
      hostname: "h.local",
      os: "darwin",
      agentVersion: "0.2.0",
      status: "active",
    })
    .returning({ id: devices.id });

  await db.insert(clientSessions).values({
    id: opts.sessionId,
    deviceId: device!.id,
    userId: opts.userId,
    orgId: opts.orgId,
    sourceClient: opts.sourceClient ?? "claude-code",
    startedAt: opts.startedAt,
    lastEventAt: opts.startedAt,
  });

  const rows = Array.from({ length: opts.events }, (_, i) => ({
    orgId: opts.orgId,
    deviceId: device!.id,
    sessionId: opts.sessionId,
    eventId: `${opts.sessionId}-e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    eventType: "message",
    timestamp: opts.startedAt,
    source: "transcript",
  }));
  await db.insert(clientEvents).values(rows);
}

describe("sessions router — integration", () => {
  it("orgSummary aggregates per member with source split and event counts", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      orgId: org.id,
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    await seedSession(t.db, {
      userId: member.id,
      orgId: org.id,
      sessionId: "s1",
      startedAt: new Date("2024-06-01T10:00:00Z"),
      events: 4,
    });
    await seedSession(t.db, {
      userId: member.id,
      orgId: org.id,
      sessionId: "s2",
      sourceClient: "codex",
      startedAt: new Date("2024-06-02T10:00:00Z"),
      events: 2,
    });

    const caller = await callerFor({ db: t.db, userId: admin.id });
    const res = await caller.sessions.orgSummary({
      orgId: org.id,
      from: "2024-05-01T00:00:00Z",
      to: "2024-07-01T00:00:00Z",
    });

    const row = res.members.find((m) => m.userId === member.id)!;
    expect(row.sessionCount).toBe(2);
    expect(row.eventCount).toBe(6);
    expect(row.sources).toEqual({ "claude-code": 1, codex: 1 });
    expect(row.firstActivity).toBeTruthy();
  });

  it("orgSummary is FORBIDDEN for a non-admin member", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: member.id });
    await expect(
      caller.sessions.orgSummary({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listForUser returns a member's sessions newest-first with event counts and paginates", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      orgId: org.id,
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });

    for (let i = 0; i < 3; i++) {
      await seedSession(t.db, {
        userId: member.id,
        orgId: org.id,
        sessionId: `p${i}`,
        startedAt: new Date(`2024-06-0${i + 1}T10:00:00Z`),
        events: i + 1,
      });
    }

    const caller = await callerFor({ db: t.db, userId: admin.id });
    const first = await caller.sessions.listForUser({
      orgId: org.id,
      userId: member.id,
      from: "2024-05-01T00:00:00Z",
      to: "2024-07-01T00:00:00Z",
      limit: 2,
    });
    expect(first.sessions).toHaveLength(2);
    // newest first
    expect(first.sessions[0]!.id).toBe("p2");
    expect(first.sessions[0]!.eventCount).toBe(3);
    expect(first.nextCursor).toBeTruthy();

    const second = await caller.sessions.listForUser({
      orgId: org.id,
      userId: member.id,
      from: "2024-05-01T00:00:00Z",
      to: "2024-07-01T00:00:00Z",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]!.id).toBe("p0");
    expect(second.nextCursor).toBeNull();
  });

  it("listForUser lets a member read their OWN sessions", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });
    await seedSession(t.db, {
      userId: member.id,
      orgId: org.id,
      sessionId: "own1",
      startedAt: new Date("2024-06-01T10:00:00Z"),
      events: 1,
    });
    const caller = await callerFor({ db: t.db, userId: member.id });
    const res = await caller.sessions.listForUser({
      orgId: org.id,
      userId: member.id,
      from: "2024-05-01T00:00:00Z",
      to: "2024-07-01T00:00:00Z",
    });
    expect(res.sessions).toHaveLength(1);
  });

  it("listForUser FORBIDS a member reading another member's sessions", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, { orgId: org.id });
    const b = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor({ db: t.db, userId: a.id });
    await expect(
      caller.sessions.listForUser({ orgId: org.id, userId: b.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
