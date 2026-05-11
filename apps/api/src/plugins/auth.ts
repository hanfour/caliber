import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { createDb, sessions, users } from "@caliber/db";
import { resolvePermissions, type UserPermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
    perm: UserPermissions | null;
  }
  interface FastifyInstance {
    db: ReturnType<typeof createDb>["db"];
  }
}

export interface AuthPluginOptions {
  env: ServerEnv;
}

export const authPlugin = fp<AuthPluginOptions>(async (fastify, opts) => {
  const { db, pool } = createDb(opts.env.DATABASE_URL);
  fastify.addHook("onClose", async () => {
    await pool.end();
  });
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("perm", null);
  fastify.decorate("db", db);

  // Auth.js v5 derives the `__Secure-` prefix from the URL scheme
  // (`useSecureCookies = url.startsWith("https://")`), NOT from NODE_ENV.
  // Self-hosted deploys on http://localhost (Mode 1 of LOCAL_DEPLOY.md) get
  // a non-prefixed cookie even though NODE_ENV=production. Mirror that rule
  // here so api can find the session cookie that web actually set.
  const cookieName = opts.env.NEXTAUTH_URL.startsWith("https://")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

  fastify.addHook("onRequest", async (req) => {
    const token = req.cookies[cookieName];
    if (!token) return;

    const row = await db
      .select({
        userId: sessions.userId,
        expires: sessions.expires,
        email: users.email,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.sessionToken, token))
      .limit(1)
      .then((r) => r[0]);

    if (row && row.expires > new Date()) {
      req.user = { id: row.userId, email: row.email };
      req.perm = await resolvePermissions(db, row.userId);
    }
  });
});
