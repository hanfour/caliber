import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  organizations,
  departments,
  teams,
  users,
  sessions,
  organizationMembers,
  teamMembers,
  roleAssignments,
  invites,
  auditLogs,
  usageLogs,
  apiKeys,
  credentialVault,
  upstreamAccounts,
} from "@caliber/db";
import type { ServerEnv } from "@caliber/config/env";

const seedUser = z.object({
  id: z.string().uuid().optional(),
  email: z.string().email(),
  name: z.string().optional(),
  sessionToken: z.string().optional(),
  sessionTtlSeconds: z.number().int().positive().optional(),
});

const seedOrg = z.object({
  id: z.string().uuid().optional(),
  slug: z.string(),
  name: z.string(),
});

const seedRole = z.object({
  userId: z.string().uuid(),
  role: z.enum([
    "super_admin",
    "org_admin",
    "dept_manager",
    "team_manager",
    "member",
  ]),
  scopeType: z.enum(["global", "organization", "department", "team"]),
  scopeId: z.string().uuid().optional(),
});

const seedOrgMember = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
});

const payload = z
  .object({
    reset: z.boolean().default(true),
    orgs: z.array(seedOrg).default([]),
    users: z.array(seedUser).default([]),
    orgMembers: z.array(seedOrgMember).default([]),
    roleAssignments: z.array(seedRole).default([]),
  })
  .default({});

export const testSeedRoutes =
  (env: ServerEnv): FastifyPluginAsync =>
  async (fastify) => {
    const gatingActive =
      env.NODE_ENV !== "production" &&
      env.ENABLE_TEST_SEED === true &&
      !!env.TEST_SEED_TOKEN;

    if (!gatingActive) return;

    fastify.post("/test-seed", async (req, reply) => {
      const header = req.headers["x-test-seed-token"];
      if (typeof header !== "string" || header !== env.TEST_SEED_TOKEN) {
        reply.code(403);
        return { error: "forbidden" };
      }

      const body = payload.parse(req.body ?? {});
      const db = fastify.db;

      if (body.reset) {
        // audit_logs.actor_user_id is ON DELETE SET NULL, so TRUNCATE users
        // CASCADE won't automatically clean audit rows. List them explicitly.
        //
        // Gateway tables listed first (child-first). FK chain:
        //   usage_logs → api_keys, upstream_accounts, users
        //   credential_vault → upstream_accounts
        //   api_keys → users, organizations
        //   upstream_accounts → organizations, teams
        // CASCADE would cover most of this transitively, but listing them
        // explicitly keeps intent obvious and matches existing style.
        await db.execute(sql`
          TRUNCATE TABLE
            ${usageLogs},
            ${apiKeys},
            ${credentialVault},
            ${upstreamAccounts},
            ${auditLogs},
            ${invites},
            ${roleAssignments},
            ${teamMembers},
            ${organizationMembers},
            ${teams},
            ${departments},
            ${organizations},
            ${sessions},
            ${users}
          RESTART IDENTITY CASCADE
        `);
      }

      const insertedOrgs: Array<{ id: string; slug: string; name: string }> =
        [];
      for (const o of body.orgs) {
        const [row] = await db
          .insert(organizations)
          .values({ id: o.id, slug: o.slug, name: o.name })
          .returning({
            id: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
          });
        if (row) insertedOrgs.push(row);
      }

      const insertedUsers: Array<{
        id: string;
        email: string;
        sessionToken?: string;
      }> = [];
      for (const u of body.users) {
        const [row] = await db
          .insert(users)
          .values({ id: u.id, email: u.email, name: u.name })
          .returning({ id: users.id, email: users.email });
        if (!row) continue;
        let sessionToken: string | undefined;
        if (u.sessionToken) {
          const ttl = (u.sessionTtlSeconds ?? 3600) * 1000;
          await db.insert(sessions).values({
            sessionToken: u.sessionToken,
            userId: row.id,
            expires: new Date(Date.now() + ttl),
          });
          sessionToken = u.sessionToken;
        }
        insertedUsers.push({ ...row, sessionToken });
      }

      for (const om of body.orgMembers) {
        await db
          .insert(organizationMembers)
          .values({ orgId: om.orgId, userId: om.userId })
          .onConflictDoNothing();
      }

      for (const ra of body.roleAssignments) {
        await db.insert(roleAssignments).values({
          userId: ra.userId,
          role: ra.role,
          scopeType: ra.scopeType,
          scopeId: ra.scopeId,
        });
      }

      return {
        ok: true,
        resetAt: body.reset ? new Date().toISOString() : null,
        orgs: insertedOrgs,
        users: insertedUsers,
      };
    });
  };
