import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import {
  organizations,
  departments,
  teams,
  users,
  roleAssignments,
} from "@caliber/db";
import * as schema from "@caliber/db/schema";
import { resolvePermissions } from "../../../src/rbac/permissions";
import { can } from "../../../src/rbac/check";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema }) as unknown as ReturnType<typeof drizzle>;
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("resolvePermissions", () => {
  it("expands org_admin scope to all depts+teams in that org", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "a@x.com" })
      .returning();
    const [org] = await db
      .insert(organizations)
      .values({ slug: "o-a", name: "A" })
      .returning();
    const [dept] = await db
      .insert(departments)
      .values({ orgId: org!.id, name: "D", slug: "d" })
      .returning();
    const [team] = await db
      .insert(teams)
      .values({ orgId: org!.id, departmentId: dept!.id, name: "T", slug: "t" })
      .returning();
    await db.insert(roleAssignments).values({
      userId: user!.id,
      role: "org_admin",
      scopeType: "organization",
      scopeId: org!.id,
    });

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.coveredOrgs.has(org!.id)).toBe(true);
    expect(perm.coveredDepts.has(dept!.id)).toBe(true);
    expect(perm.coveredTeams.has(team!.id)).toBe(true);
    expect(can(perm, { type: "team.update", teamId: team!.id })).toBe(true);
  });

  it("dept_manager coverage includes parent org so can() inheritance works", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "dm@x.com" })
      .returning();
    const [org] = await db
      .insert(organizations)
      .values({ slug: "o-dm", name: "DM" })
      .returning();
    const [dept] = await db
      .insert(departments)
      .values({ orgId: org!.id, name: "D", slug: "d-dm" })
      .returning();
    const [team] = await db
      .insert(teams)
      .values({
        orgId: org!.id,
        departmentId: dept!.id,
        name: "T",
        slug: "t-dm",
      })
      .returning();
    await db.insert(roleAssignments).values({
      userId: user!.id,
      role: "dept_manager",
      scopeType: "department",
      scopeId: dept!.id,
    });

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.coveredOrgs.has(org!.id)).toBe(true);
    expect(perm.coveredDepts.has(dept!.id)).toBe(true);
    expect(perm.coveredTeams.has(team!.id)).toBe(true);
    expect(can(perm, { type: "team.update", teamId: team!.id })).toBe(true);
  });

  it("revoked assignments are ignored", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "b@x.com" })
      .returning();
    const [org] = await db
      .insert(organizations)
      .values({ slug: "o-b", name: "B" })
      .returning();
    await db.insert(roleAssignments).values({
      userId: user!.id,
      role: "org_admin",
      scopeType: "organization",
      scopeId: org!.id,
      revokedAt: new Date(),
    });

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.coveredOrgs.has(org!.id)).toBe(false);
    expect(can(perm, { type: "org.update", orgId: org!.id })).toBe(false);
  });

  it("global scope assignment populates rolesAtGlobal", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "super@x.com" })
      .returning();
    await db.insert(roleAssignments).values({
      userId: user!.id,
      role: "super_admin",
      scopeType: "global",
      scopeId: null,
    });

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.rolesAtGlobal.has("super_admin")).toBe(true);
    // Global scope also expands to cover all orgs/depts/teams.
    expect(can(perm, { type: "org.update", orgId: "any-org" })).toBe(true);
  });

  it("multi-role on same scope accumulates in the same set", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "multi@x.com" })
      .returning();
    const [org] = await db
      .insert(organizations)
      .values({ slug: "o-multi", name: "Multi" })
      .returning();
    await db.insert(roleAssignments).values([
      {
        userId: user!.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: org!.id,
      },
      {
        userId: user!.id,
        role: "member",
        scopeType: "organization",
        scopeId: org!.id,
      },
    ]);

    const perm = await resolvePermissions(db as never, user!.id);
    const rolesForOrg = perm.rolesByOrg.get(org!.id);
    expect(rolesForOrg?.has("org_admin")).toBe(true);
    expect(rolesForOrg?.has("member")).toBe(true);
  });

  it("team-scope assignment propagates to coveredOrgs via parent org index", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "team-prop@x.com" })
      .returning();
    const [org] = await db
      .insert(organizations)
      .values({ slug: "o-tp", name: "TP" })
      .returning();
    const [team] = await db
      .insert(teams)
      .values({ orgId: org!.id, name: "T", slug: "t-tp" })
      .returning();
    await db.insert(roleAssignments).values({
      userId: user!.id,
      role: "team_manager",
      scopeType: "team",
      scopeId: team!.id,
    });

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.coveredOrgs.has(org!.id)).toBe(true);
    expect(perm.coveredTeams.has(team!.id)).toBe(true);
  });

  it("multi-scope user unions coverage", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: "c@x.com" })
      .returning();
    const [org1] = await db
      .insert(organizations)
      .values({ slug: "o-c1", name: "C1" })
      .returning();
    const [org2] = await db
      .insert(organizations)
      .values({ slug: "o-c2", name: "C2" })
      .returning();
    const [team2] = await db
      .insert(teams)
      .values({ orgId: org2!.id, name: "T2", slug: "t-c2" })
      .returning();

    await db.insert(roleAssignments).values([
      {
        userId: user!.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: org1!.id,
      },
      {
        userId: user!.id,
        role: "team_manager",
        scopeType: "team",
        scopeId: team2!.id,
      },
    ]);

    const perm = await resolvePermissions(db as never, user!.id);
    expect(perm.coveredOrgs.has(org1!.id)).toBe(true);
    expect(perm.coveredTeams.has(team2!.id)).toBe(true);
    expect(can(perm, { type: "team.update", teamId: team2!.id })).toBe(true);
    expect(can(perm, { type: "org.update", orgId: org2!.id })).toBe(false);
  });
});
