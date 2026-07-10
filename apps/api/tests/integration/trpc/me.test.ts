import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { organizationMembers } from "@caliber/db";
import {
  setupTestDb,
  makeOrg,
  makeDept,
  makeTeam,
  makeUser,
  callerFor,
  anonCaller,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("me router", () => {
  it("requires authentication for session", async () => {
    const caller = await anonCaller(t.db);
    await expect(caller.me.session()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns session for authenticated user", async () => {
    const org = await makeOrg(t.db);
    const dept = await makeDept(t.db, org.id);
    const team = await makeTeam(t.db, org.id, { departmentId: dept.id });
    const user = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const s = await caller.me.session();
    expect(s.user.id).toBe(user.id);
    expect(s.coveredOrgs).toContain(org.id);
    expect(s.deptOrgById).toContainEqual([dept.id, org.id]);
    expect(s.teamOrgById).toContainEqual([team.id, org.id]);
    expect(s.teamDeptById).toContainEqual([team.id, dept.id]);
  });

  it("updateProfile sets name", async () => {
    const user = await makeUser(t.db);
    const caller = await callerFor(t.db, user.id, user.email);
    const updated = await caller.me.updateProfile({ name: "New Name" });
    expect(updated?.name).toBe("New Name");
  });

  it("captureDisclosure returns capture-enabled orgs", async () => {
    const org = await makeOrg(t.db, { contentCaptureEnabled: true });
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const disclosure = await caller.me.captureDisclosure();
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]?.orgId).toBe(org.id);
    expect(disclosure[0]?.contentCaptureEnabled).toBe(true);
    expect(disclosure[0]?.retentionDays).toBe(90);
  });

  it("captureDisclosure skips capture-disabled orgs", async () => {
    const org = await makeOrg(t.db, { contentCaptureEnabled: false });
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const disclosure = await caller.me.captureDisclosure();
    expect(disclosure).toHaveLength(0);
  });

  it("captureDisclosure returns only enabled orgs from multiple", async () => {
    const enabledOrg = await makeOrg(t.db, { contentCaptureEnabled: true });
    const disabledOrg = await makeOrg(t.db, { contentCaptureEnabled: false });
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: enabledOrg.id,
      orgId: enabledOrg.id,
    });
    // Add user to disabled org
    await t.db.insert(organizationMembers).values({
      orgId: disabledOrg.id,
      userId: user.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const disclosure = await caller.me.captureDisclosure();
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]?.orgId).toBe(enabledOrg.id);
  });

  it("captureDisclosure returns custom retentionDays override", async () => {
    const org = await makeOrg(t.db, {
      contentCaptureEnabled: true,
      retentionDaysOverride: 30,
    });
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const disclosure = await caller.me.captureDisclosure();
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]?.retentionDays).toBe(30);
  });
});
