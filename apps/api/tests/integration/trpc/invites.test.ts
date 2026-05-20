import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("invites router", () => {
  it("org_admin can create invite in own org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const caller = await callerFor(t.db, admin.id);
    const inv = await caller.invites.create({
      orgId: org.id,
      email: "newbie@x.test",
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
    });
    expect(inv?.email).toBe("newbie@x.test");
    expect((inv?.token ?? "").length).toBeGreaterThan(10);
  });

  it("member cannot create invite", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
    });
    const caller = await callerFor(t.db, user.id);
    await expect(
      caller.invites.create({
        orgId: org.id,
        email: "x@x.test",
        role: "member",
        scopeType: "organization",
        scopeId: org.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accept links invited user", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const invitee = await makeUser(t.db, { email: "invited@x.test" });
    const aCaller = await callerFor(t.db, admin.id);
    const inv = await aCaller.invites.create({
      orgId: org.id,
      email: "invited@x.test",
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
    });
    const iCaller = await callerFor(t.db, invitee.id, invitee.email);
    const res = await iCaller.invites.accept({ token: inv!.token });
    expect(res.orgId).toBe(org.id);
  });

  it("accept fails when email mismatches", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const invitee = await makeUser(t.db);
    const aCaller = await callerFor(t.db, admin.id);
    const inv = await aCaller.invites.create({
      orgId: org.id,
      email: "wrong@x.test",
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
    });
    const iCaller = await callerFor(t.db, invitee.id, invitee.email);
    await expect(
      iCaller.invites.accept({ token: inv!.token }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("create rejects organization scope with mismatched scopeId", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
    });
    const caller = await callerFor(t.db, adminA.id);
    await expect(
      caller.invites.create({
        orgId: orgA.id,
        email: "x@x.test",
        role: "org_admin",
        scopeType: "organization",
        scopeId: orgB.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("list forbidden for member (requires user.invite)", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
    });
    const caller = await callerFor(t.db, user.id);
    await expect(caller.invites.list({ orgId: org.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
