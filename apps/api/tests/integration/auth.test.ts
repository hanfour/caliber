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
import { sessions, users } from "@caliber/db";
import { ignorePoolTeardownErrors } from "../factories/db.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let insertedUserId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = ignorePoolTeardownErrors(
    new pg.Pool({ connectionString: container.getConnectionUri() }),
  );
  const db = drizzle(pool, { schema: { users, sessions } });
  await migrate(db, { migrationsFolder });

  const [user] = await db
    .insert(users)
    .values({ email: "u@test.com", name: "U" })
    .returning();

  insertedUserId = user!.id;

  await db.insert(sessions).values({
    sessionToken: "test-token",
    userId: insertedUserId,
    expires: new Date(Date.now() + 60_000),
  });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

function env(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  } as unknown as import("@caliber/config").ServerEnv;
}

describe("authPlugin", () => {
  it("decorates req.user when a valid session cookie is present", async () => {
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env: env() });
    app.get("/who", async (req) => ({ user: req.user }));

    const res = await app.inject({
      method: "GET",
      url: "/who",
      cookies: { "authjs.session-token": "test-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "u@test.com" });
    await app.close();
  });

  it("leaves req.user null when no cookie present", async () => {
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env: env() });
    app.get("/who", async (req) => ({ user: req.user }));

    const res = await app.inject({ method: "GET", url: "/who" });
    expect(res.json().user).toBeNull();
    await app.close();
  });

  it("attaches req.perm alongside req.user", async () => {
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, { env: env() });
    app.get("/who", async (req) => ({
      user: req.user,
      hasPerm: req.perm !== null,
      assignments: req.perm?.assignments.length ?? 0,
    }));

    const res = await app.inject({
      method: "GET",
      url: "/who",
      cookies: { "authjs.session-token": "test-token" },
    });
    expect(res.json().hasPerm).toBe(true);
    expect(res.json().assignments).toBe(0); // beforeAll didn't insert any role_assignments
    await app.close();
  });

  // Cookie-name selection should mirror Auth.js v5's URL-scheme rule, NOT
  // NODE_ENV. Without this the http://localhost self-hosted path returns
  // 401 on every tRPC call because web sets `authjs.session-token` and api
  // looks for `__Secure-authjs.session-token`.

  it("reads the non-prefixed cookie when NEXTAUTH_URL is http://", async () => {
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, {
      env: env({ NEXTAUTH_URL: "http://localhost:3000" }),
    });
    app.get("/who", async (req) => ({ user: req.user }));

    const res = await app.inject({
      method: "GET",
      url: "/who",
      cookies: { "authjs.session-token": "test-token" },
    });
    expect(res.json().user).toMatchObject({ email: "u@test.com" });
    await app.close();
  });

  it("reads the __Secure- prefixed cookie when NEXTAUTH_URL is https://", async () => {
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, {
      env: env({ NEXTAUTH_URL: "https://aide.example.com" }),
    });
    app.get("/who", async (req) => ({ user: req.user }));

    const res = await app.inject({
      method: "GET",
      url: "/who",
      cookies: { "__Secure-authjs.session-token": "test-token" },
    });
    expect(res.json().user).toMatchObject({ email: "u@test.com" });
    await app.close();
  });

  it("ignores the wrong cookie name (https build sees http cookie)", async () => {
    // If api looks for the Secure-prefixed name, a non-prefixed cookie is
    // silently dropped — confirms the selector isn't trying both names.
    const app = Fastify();
    await app.register(cookiesPlugin);
    await app.register(authPlugin, {
      env: env({ NEXTAUTH_URL: "https://aide.example.com" }),
    });
    app.get("/who", async (req) => ({ user: req.user }));

    const res = await app.inject({
      method: "GET",
      url: "/who",
      cookies: { "authjs.session-token": "test-token" },
    });
    expect(res.json().user).toBeNull();
    await app.close();
  });
});
