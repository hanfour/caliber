import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestDb,
  makeOrg,
  makeTeam,
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

describe("roles router", () => {
  it("org_admin can grant team_manager on a team", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const target = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor(t.db, admin.id);
    const res = await caller.roles.grant({
      userId: target.id,
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
    });
    expect(res?.role).toBe("team_manager");
  });

  it("team_manager cannot grant team_manager (no peer escalation)", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const mgr = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
    });
    const target = await makeUser(t.db);
    const caller = await callerFor(t.db, mgr.id);
    await expect(
      caller.roles.grant({
        userId: target.id,
        role: "team_manager",
        scopeType: "team",
        scopeId: team.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revoke marks assignment revoked", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const target = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor(t.db, admin.id);
    const granted = await caller.roles.grant({
      userId: target.id,
      role: "member",
      scopeType: "team",
      scopeId: team.id,
    });
    const revoked = await caller.roles.revoke({ assignmentId: granted!.id });
    expect(revoked.id).toBe(granted!.id);
  });

  it("org_admin of org A cannot revoke a role in org B", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const teamB = await makeTeam(t.db, orgB.id);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
    });
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
    });
    const victim = await makeUser(t.db, { orgId: orgB.id });

    const callerB = await callerFor(t.db, adminB.id);
    const granted = await callerB.roles.grant({
      userId: victim.id,
      role: "team_manager",
      scopeType: "team",
      scopeId: teamB.id,
    });

    const callerA = await callerFor(t.db, adminA.id);
    await expect(
      callerA.roles.revoke({ assignmentId: granted!.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("listForUser: org_admin can list roles of user in own org", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor(t.db, admin.id);
    const list = await caller.roles.listForUser({ userId: member.id });
    expect(Array.isArray(list)).toBe(true);
  });

  it("org_admin of org A cannot grant role on an org-B-only user", async () => {
    // Cross-tenant guard: even when the grantor has authority at the target
    // scope, the grantee must actually live in the same org.
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const teamA = await makeTeam(t.db, orgA.id);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
    });
    const orgBOnlyUser = await makeUser(t.db, { orgId: orgB.id });
    const caller = await callerFor(t.db, adminA.id);
    await expect(
      caller.roles.grant({
        userId: orgBOnlyUser.id,
        role: "team_manager",
        scopeType: "team",
        scopeId: teamA.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("team_manager cannot listForUser for an org-peer outside their team", async () => {
    const org = await makeOrg(t.db);
    const teamA = await makeTeam(t.db, org.id);
    const teamB = await makeTeam(t.db, org.id);
    const mgr = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: teamA.id,
    });
    const peer = await makeUser(t.db, { orgId: org.id, teamId: teamB.id });
    const caller = await callerFor(t.db, mgr.id);
    await expect(
      caller.roles.listForUser({ userId: peer.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
