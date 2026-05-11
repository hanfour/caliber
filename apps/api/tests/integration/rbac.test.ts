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
import Fastify from "fastify";
import { cookiesPlugin } from "../../src/plugins/cookies.js";
import { authPlugin } from "../../src/plugins/auth.js";
import { requirePerm } from "../../src/plugins/rbac.js";
import { users, sessions, organizations, roleAssignments } from "@caliber/db";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let adminId: string;
let memberId: string;
let orgId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "o", name: "O" })
    .returning();
  orgId = org!.id;
  const [admin] = await db
    .insert(users)
    .values({ email: "a@t.com" })
    .returning();
  adminId = admin!.id;
  const [member] = await db
    .insert(users)
    .values({ email: "m@t.com" })
    .returning();
  memberId = member!.id;

  await db.insert(roleAssignments).values({
    userId: adminId,
    role: "org_admin",
    scopeType: "organization",
    scopeId: orgId,
  });
  await db.insert(sessions).values([
    {
      sessionToken: "admin",
      userId: adminId,
      expires: new Date(Date.now() + 60000),
    },
    {
      sessionToken: "member",
      userId: memberId,
      expires: new Date(Date.now() + 60000),
    },
  ]);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

function baseEnv() {
  return {
    NODE_ENV: "test" as const,
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: "a".repeat(32),
    NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com",
    BOOTSTRAP_DEFAULT_ORG_SLUG: "demo",
    BOOTSTRAP_DEFAULT_ORG_NAME: "Demo",
    LOG_LEVEL: "error" as const,
    ENABLE_SWAGGER: false,
  } as unknown as import("@caliber/config").ServerEnv;
}

function buildApp() {
  const app = Fastify();
  return { app, env: baseEnv() };
}

describe("requirePerm", () => {
  it("returns 401 when no session", async () => {
    const { app, env } = buildApp();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env });
    app.get(
      "/orgs/:id",
      {
        preHandler: [
          requirePerm((req) => ({
            type: "org.update",
            orgId: (req.params as { id: string }).id,
          })),
        ],
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({ method: "GET", url: `/orgs/${orgId}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("allows org_admin to update own org", async () => {
    const { app, env } = buildApp();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env });
    app.get(
      "/orgs/:id",
      {
        preHandler: [
          requirePerm((req) => ({
            type: "org.update",
            orgId: (req.params as { id: string }).id,
          })),
        ],
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}`,
      cookies: { "authjs.session-token": "admin" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("forbids member from updating org", async () => {
    const { app, env } = buildApp();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env });
    app.get(
      "/orgs/:id",
      {
        preHandler: [
          requirePerm((req) => ({
            type: "org.update",
            orgId: (req.params as { id: string }).id,
          })),
        ],
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}`,
      cookies: { "authjs.session-token": "member" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
