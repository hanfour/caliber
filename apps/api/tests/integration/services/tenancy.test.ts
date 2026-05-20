import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg, makeDept, makeTeam } from "../../factories/org.js";
import { makeUser } from "../../factories/user.js";
import {
  assertUserMemberOfOrg,
  assertDepartmentBelongsToOrg,
  assertTeamBelongsToOrg,
  assertScopeBelongsToOrg,
  resolveScopeOrgId,
} from "../../../src/services/tenancy.js";
import { ServiceError } from "../../../src/trpc/errors.js";

describe("tenancy assertions (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    // Order matters: child tables before parents.
    await testDb.db.execute(sql`
      TRUNCATE
        team_members,
        organization_members,
        teams,
        departments,
        organizations,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  describe("assertUserMemberOfOrg", () => {
    it("passes when user is a member of the org", async () => {
      const org = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db, { orgId: org.id });
      await expect(
        assertUserMemberOfOrg(testDb.db, user.id, org.id),
      ).resolves.toBeUndefined();
    });

    it("throws FORBIDDEN when user belongs to a different org", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db, { orgId: orgA.id });
      await expect(
        assertUserMemberOfOrg(testDb.db, user.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "FORBIDDEN",
      });
    });

    it("throws FORBIDDEN when user has no org membership", async () => {
      const org = await makeOrg(testDb.db);
      const user = await makeUser(testDb.db);
      await expect(
        assertUserMemberOfOrg(testDb.db, user.id, org.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "FORBIDDEN",
      });
    });
  });

  describe("assertDepartmentBelongsToOrg", () => {
    it("passes when department belongs to the org", async () => {
      const org = await makeOrg(testDb.db);
      const dept = await makeDept(testDb.db, org.id);
      await expect(
        assertDepartmentBelongsToOrg(testDb.db, dept.id, org.id),
      ).resolves.toBeUndefined();
    });

    it("throws BAD_REQUEST when department belongs to a different org", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const dept = await makeDept(testDb.db, orgA.id);
      await expect(
        assertDepartmentBelongsToOrg(testDb.db, dept.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });
  });

  describe("assertTeamBelongsToOrg", () => {
    it("passes when team belongs to the org", async () => {
      const org = await makeOrg(testDb.db);
      const team = await makeTeam(testDb.db, org.id);
      await expect(
        assertTeamBelongsToOrg(testDb.db, team.id, org.id),
      ).resolves.toBeUndefined();
    });

    it("throws BAD_REQUEST when team belongs to a different org", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const team = await makeTeam(testDb.db, orgA.id);
      await expect(
        assertTeamBelongsToOrg(testDb.db, team.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });
  });

  describe("assertScopeBelongsToOrg", () => {
    it("no-op for global scope", async () => {
      const org = await makeOrg(testDb.db);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "global", null, org.id),
      ).resolves.toBeUndefined();
    });

    it("passes for organization scope when scopeId === orgId", async () => {
      const org = await makeOrg(testDb.db);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "organization", org.id, org.id),
      ).resolves.toBeUndefined();
    });

    it("throws BAD_REQUEST for organization scope when scopeId !== orgId", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "organization", orgA.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("throws BAD_REQUEST for non-global scopes with null scopeId", async () => {
      const org = await makeOrg(testDb.db);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "department", null, org.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
      await expect(
        assertScopeBelongsToOrg(testDb.db, "team", null, org.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
      await expect(
        assertScopeBelongsToOrg(testDb.db, "organization", null, org.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("delegates to assertDepartmentBelongsToOrg for department scope", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const dept = await makeDept(testDb.db, orgA.id);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "department", dept.id, orgA.id),
      ).resolves.toBeUndefined();
      await expect(
        assertScopeBelongsToOrg(testDb.db, "department", dept.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });

    it("delegates to assertTeamBelongsToOrg for team scope", async () => {
      const orgA = await makeOrg(testDb.db);
      const orgB = await makeOrg(testDb.db);
      const team = await makeTeam(testDb.db, orgA.id);
      await expect(
        assertScopeBelongsToOrg(testDb.db, "team", team.id, orgA.id),
      ).resolves.toBeUndefined();
      await expect(
        assertScopeBelongsToOrg(testDb.db, "team", team.id, orgB.id),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });
  });

  describe("resolveScopeOrgId", () => {
    it("returns null for global scope", async () => {
      await expect(resolveScopeOrgId(testDb.db, "global", null)).resolves.toBeNull();
    });

    it("returns scopeId for organization scope", async () => {
      const org = await makeOrg(testDb.db);
      await expect(
        resolveScopeOrgId(testDb.db, "organization", org.id),
      ).resolves.toBe(org.id);
    });

    it("resolves department.orgId for department scope", async () => {
      const org = await makeOrg(testDb.db);
      const dept = await makeDept(testDb.db, org.id);
      await expect(
        resolveScopeOrgId(testDb.db, "department", dept.id),
      ).resolves.toBe(org.id);
    });

    it("resolves team.orgId for team scope", async () => {
      const org = await makeOrg(testDb.db);
      const team = await makeTeam(testDb.db, org.id);
      await expect(
        resolveScopeOrgId(testDb.db, "team", team.id),
      ).resolves.toBe(org.id);
    });

    it("throws NOT_FOUND for unknown department/team scopeId", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      await expect(
        resolveScopeOrgId(testDb.db, "department", fakeId),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "NOT_FOUND",
      });
      await expect(
        resolveScopeOrgId(testDb.db, "team", fakeId),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "NOT_FOUND",
      });
    });

    it("throws BAD_REQUEST when non-global scope has null scopeId", async () => {
      await expect(
        resolveScopeOrgId(testDb.db, "organization", null),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
      await expect(
        resolveScopeOrgId(testDb.db, "department", null),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
      await expect(
        resolveScopeOrgId(testDb.db, "team", null),
      ).rejects.toMatchObject({
        constructor: ServiceError,
        code: "BAD_REQUEST",
      });
    });
  });
});
