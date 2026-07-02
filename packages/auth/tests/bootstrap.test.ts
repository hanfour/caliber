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
import { schema } from "@caliber/db";
import type { Database } from "@caliber/db";
import { users, organizations, invites } from "@caliber/db";
import { decideSignUp, type BootstrapConfig } from "../src/bootstrap.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

const cfg: BootstrapConfig = {
  superAdminEmail: "admin@example.com",
  defaultOrgSlug: "demo",
  defaultOrgName: "Demo",
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool, { schema }) as unknown as Database;
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("decideSignUp", () => {
  it("allows first user when email matches BOOTSTRAP_SUPER_ADMIN_EMAIL", async () => {
    const decision = await decideSignUp(db, "admin@example.com", cfg);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.action).toBe("bootstrap");
    }
  });

  it("denies first user when email does NOT match admin email", async () => {
    const decision = await decideSignUp(db, "stranger@example.com", cfg);
    expect(decision.allowed).toBe(false);
  });

  it("returns link action for an existing user", async () => {
    const [existing] = await db
      .insert(users)
      .values({ email: "existing-link@example.com" })
      .returning();

    const decision = await decideSignUp(db, "existing-link@example.com", cfg);
    expect(decision.allowed).toBe(true);
    if (decision.allowed && decision.action === "link") {
      expect(decision.userId).toBe(existing!.id);
    } else {
      throw new Error("expected link decision");
    }
  });

  it("returns invite action for a pending valid invite", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ slug: "invite-decide", name: "ID" })
      .returning();
    const [inviter] = await db
      .insert(users)
      .values({ email: "inviter-decide@example.com" })
      .returning();
    const [invite] = await db
      .insert(invites)
      .values({
        orgId: org!.id,
        email: "pending-decide@example.com",
        role: "member",
        scopeType: "organization",
        scopeId: org!.id,
        invitedBy: inviter!.id,
        expiresAt: new Date(Date.now() + 60_000),
        token: "tok-decide-" + Math.random().toString(36).slice(2),
      })
      .returning();

    const decision = await decideSignUp(db, "pending-decide@example.com", cfg);
    expect(decision.allowed).toBe(true);
    if (decision.allowed && decision.action === "invite") {
      expect(decision.inviteId).toBe(invite!.id);
      expect(decision.orgId).toBe(org!.id);
    } else {
      throw new Error("expected invite decision");
    }
  });
});
