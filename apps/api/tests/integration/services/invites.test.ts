import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { invites, roleAssignments } from "@caliber/db";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg, makeDept, makeTeam } from "../../factories/org.js";
import { makeUser } from "../../factories/user.js";
import {
  createInvite,
  acceptInvite,
} from "../../../src/services/invites.js";
import { ServiceError } from "../../../src/trpc/errors.js";

// Service-layer defense-in-depth tests for invites tenancy.
//
// The router's permission layer already blocks most cross-tenant dept/team
// scopeId requests, but the service-layer assertion is the last line of
// defense if a future refactor or a non-tRPC caller (CLI, internal job)
// reaches createInvite/acceptInvite directly.

describe("invites service (cross-tenant guard)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`
      TRUNCATE
        role_assignments,
        invites,
        team_members,
        organization_members,
        teams,
        departments,
        organizations,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  describe("createInvite", () => {
    it("rejects department scopeId from a different org", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const deptB = await makeDept(testDb.db, orgB.id);
      const inviter = await makeUser(testDb.db);
      await expect(
        createInvite(testDb.db, inviter, {
          orgId: orgA.id,
          email: "x@x.test",
          role: "dept_manager",
          scopeType: "department",
          scopeId: deptB.id,
        }),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("rejects team scopeId from a different org", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const teamB = await makeTeam(testDb.db, orgB.id);
      const inviter = await makeUser(testDb.db);
      await expect(
        createInvite(testDb.db, inviter, {
          orgId: orgA.id,
          email: "x@x.test",
          role: "team_manager",
          scopeType: "team",
          scopeId: teamB.id,
        }),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("rejects organization scope with mismatched scopeId", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const inviter = await makeUser(testDb.db);
      await expect(
        createInvite(testDb.db, inviter, {
          orgId: orgA.id,
          email: "x@x.test",
          role: "org_admin",
          scopeType: "organization",
          scopeId: orgB.id,
        }),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("allows in-tenant department invite", async () => {
      const org = await makeOrg(testDb.db);
      const dept = await makeDept(testDb.db, org.id);
      const inviter = await makeUser(testDb.db);
      const inv = await createInvite(testDb.db, inviter, {
        orgId: org.id,
        email: "x@x.test",
        role: "dept_manager",
        scopeType: "department",
        scopeId: dept.id,
      });
      expect(inv.orgId).toBe(org.id);
      expect(inv.scopeId).toBe(dept.id);
    });
  });

  describe("acceptInvite", () => {
    it("rejects accept when the invite scopeId no longer belongs to the org", async () => {
      // Simulates a legacy invite row that predates the create-time guard,
      // or a dept reassigned between create and accept.
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const deptB = await makeDept(testDb.db, orgB.id);
      const inviter = await makeUser(testDb.db);
      const invitee = await makeUser(testDb.db, {
        email: "future@x.test",
      });

      // Bypass createInvite so we can plant a pre-existing bad row.
      const [bad] = await testDb.db
        .insert(invites)
        .values({
          orgId: orgA.id,
          email: "future@x.test",
          role: "dept_manager",
          scopeType: "department",
          scopeId: deptB.id,
          invitedBy: inviter.id,
          expiresAt: new Date(Date.now() + 60_000),
          token: "x".repeat(40),
        })
        .returning();
      expect(bad).toBeDefined();

      await expect(
        acceptInvite(
          testDb.db,
          { id: invitee.id, email: invitee.email },
          bad!.token,
        ),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });

      // And nothing got written.
      const grants = await testDb.db
        .select()
        .from(roleAssignments)
        .where(eq(roleAssignments.userId, invitee.id));
      expect(grants).toHaveLength(0);
    });
  });
});
