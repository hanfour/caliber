import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import * as schema from "@caliber/db/schema";
import {
  users,
  organizations,
  organizationMembers,
  invites,
  roleAssignments,
} from "@caliber/db";
import { buildAuthConfig, type AuthEnv } from "../../src/config";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

const env: AuthEnv = {
  AUTH_SECRET: "x".repeat(32),
  GOOGLE_CLIENT_ID: "g",
  GOOGLE_CLIENT_SECRET: "g-secret",
  GITHUB_CLIENT_ID: "gh",
  GITHUB_CLIENT_SECRET: "gh-secret",
  superAdminEmail: "admin@example.com",
  defaultOrgSlug: "demo",
  defaultOrgName: "Demo",
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool, { schema }) as unknown as ReturnType<typeof drizzle>;
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// Ensure a clean slate between cases — other cases' inserts should not leak.
async function resetDb() {
  await db.delete(roleAssignments);
  await db.delete(organizationMembers);
  await db.delete(invites);
  await db.delete(organizations);
  await db.delete(users);
}

beforeEach(async () => {
  await resetDb();
});

describe("buildAuthConfig — shape", () => {
  it("returns a config with the expected fields", () => {
    const cfg = buildAuthConfig(db as never, env);
    expect(cfg.secret).toBe(env.AUTH_SECRET);
    expect(cfg.session).toBeDefined();
    expect(cfg.session?.strategy).toBe("database");
    expect(cfg.session?.maxAge).toBe(30 * 24 * 60 * 60);
    expect(cfg.providers).toHaveLength(2);
    expect(cfg.pages?.signIn).toBe("/sign-in");
    expect(typeof cfg.callbacks?.signIn).toBe("function");
    expect(typeof cfg.events?.createUser).toBe("function");
    expect(cfg.adapter).toBeTruthy();
  });

  it("defaults trustHost=true when AUTH_TRUST_HOST is not provided", () => {
    const cfg = buildAuthConfig(db as never, env);
    expect(cfg.trustHost).toBe(true);
  });

  it("honours an explicit AUTH_TRUST_HOST=false", () => {
    const cfg = buildAuthConfig(db as never, { ...env, AUTH_TRUST_HOST: false });
    expect(cfg.trustHost).toBe(false);
  });

  it("registers only configured providers", () => {
    const githubOnly = buildAuthConfig(db as never, {
      ...env,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });
    expect(githubOnly.providers).toHaveLength(1);
  });
});

describe("buildAuthConfig — callbacks.signIn", () => {
  it("denies sign-in when user has no email", async () => {
    const cfg = buildAuthConfig(db as never, env);
    const result = await cfg.callbacks!.signIn!({
      user: { email: null } as never,
      account: null,
    } as never);
    expect(result).toBe(false);
  });

  it("allows the super_admin bootstrap email on fresh DB", async () => {
    const cfg = buildAuthConfig(db as never, env);
    const result = await cfg.callbacks!.signIn!({
      user: { email: "admin@example.com" } as never,
      account: null,
    } as never);
    expect(result).toBe(true);
  });

  it("denies an unknown email with no invite", async () => {
    // Seed a different existing user so bootstrap path is NOT eligible.
    await db.insert(users).values({ email: "someone@example.com" });

    const cfg = buildAuthConfig(db as never, env);
    const result = await cfg.callbacks!.signIn!({
      user: { email: "stranger@example.com" } as never,
      account: null,
    } as never);
    expect(result).toBe(false);
  });

  it("allows a user whose email has a pending valid invite", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: "invited-org", name: "Invited Org" })
      .returning();
    const [inviter] = await db
      .insert(users)
      .values({ email: "inviter@example.com" })
      .returning();
    await db.insert(invites).values({
      orgId: org!.id,
      email: "invitee@example.com",
      role: "member",
      scopeType: "organization",
      scopeId: org!.id,
      invitedBy: inviter!.id,
      expiresAt: new Date(Date.now() + 60_000),
      token: "tok-signin-" + Math.random().toString(36).slice(2),
    });

    const cfg = buildAuthConfig(db as never, env);
    const result = await cfg.callbacks!.signIn!({
      user: { email: "invitee@example.com" } as never,
      account: null,
    } as never);
    expect(result).toBe(true);
  });

  it("allows an existing user to sign in (link path)", async () => {
    await db.insert(users).values({ email: "existing@example.com" });

    const cfg = buildAuthConfig(db as never, env);
    const result = await cfg.callbacks!.signIn!({
      user: { email: "existing@example.com" } as never,
      account: null,
    } as never);
    expect(result).toBe(true);
  });
});

describe("buildAuthConfig — events.createUser", () => {
  it("is a no-op when user has no email", async () => {
    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({ user: { email: null, id: "x" } } as never);
    // No rows should exist — nothing ran.
    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(0);
  });

  it("is a no-op when user has no id", async () => {
    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { email: "x@example.com", id: undefined },
    } as never);
    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(0);
  });

  it("bootstraps the first super_admin: creates org, membership, super_admin role", async () => {
    const [inserted] = await db
      .insert(users)
      .values({ email: env.superAdminEmail })
      .returning();

    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { ...inserted!, id: inserted!.id } as never,
    } as never);

    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, env.defaultOrgSlug));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.name).toBe(env.defaultOrgName);

    const members = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, inserted!.id));
    expect(members).toHaveLength(1);

    const roles = await db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, inserted!.id));
    expect(
      roles.some((r) => r.role === "super_admin" && r.scopeType === "global"),
    ).toBe(true);
  });

  it("uses existing org if slug already present (onConflictDoNothing path)", async () => {
    // Pre-create the org so insert returns no row and we fall through to the
    // findFirst branch.
    const [preOrg] = await db
      .insert(organizations)
      .values({ slug: env.defaultOrgSlug, name: "Pre-existing" })
      .returning();
    const [inserted] = await db
      .insert(users)
      .values({ email: env.superAdminEmail })
      .returning();

    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { ...inserted!, id: inserted!.id } as never,
    } as never);

    const members = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, inserted!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.orgId).toBe(preOrg!.id);
  });

  it("does NOT bootstrap when the email is not the super_admin email", async () => {
    const [inserted] = await db
      .insert(users)
      .values({ email: "not-admin@example.com" })
      .returning();

    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { ...inserted!, id: inserted!.id } as never,
    } as never);

    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(0);
    const roles = await db.select().from(roleAssignments);
    expect(roles).toHaveLength(0);
  });

  it("does NOT bootstrap when there are already other users (isFirstUser=false)", async () => {
    // Insert a different user first so super_admin is no longer "first user".
    await db.insert(users).values({ email: "first@example.com" });
    const [admin] = await db
      .insert(users)
      .values({ email: env.superAdminEmail })
      .returning();

    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { ...admin!, id: admin!.id } as never,
    } as never);

    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(0);
  });

  it("accepts a pending invite: adds member + role, marks invite accepted", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: "invite-org", name: "Invite Org" })
      .returning();
    const [inviter] = await db
      .insert(users)
      .values({ email: "inv@example.com" })
      .returning();
    const [invite] = await db
      .insert(invites)
      .values({
        orgId: org!.id,
        email: "new@example.com",
        role: "member",
        scopeType: "organization",
        scopeId: org!.id,
        invitedBy: inviter!.id,
        expiresAt: new Date(Date.now() + 60_000),
        token: "tok-" + Math.random().toString(36).slice(2),
      })
      .returning();

    const [invitee] = await db
      .insert(users)
      .values({ email: "new@example.com" })
      .returning();

    const cfg = buildAuthConfig(db as never, env);
    await cfg.events!.createUser!({
      user: { ...invitee!, id: invitee!.id } as never,
    } as never);

    const members = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, invitee!.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.orgId).toBe(org!.id);

    const roles = await db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, invitee!.id));
    expect(roles.some((r) => r.role === "member")).toBe(true);

    const [updatedInvite] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, invite!.id));
    expect(updatedInvite!.acceptedAt).not.toBeNull();
  });
});
