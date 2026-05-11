import type { NextAuthConfig } from "next-auth";
import type { Database } from "@caliber/db";
import { organizations, organizationMembers, invites, users } from "@caliber/db";
import { roleAssignments } from "@caliber/db";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { buildProviders } from "./providers.js";
import { makeAdapter } from "./drizzle-adapter.js";
import { decideSignUp, type BootstrapConfig } from "./bootstrap.js";

export interface AuthEnv extends BootstrapConfig {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GITHUB_CLIENT_ID?: string | undefined;
  GITHUB_CLIENT_SECRET?: string | undefined;
  AUTH_SECRET: string;
  /**
   * Auth.js v5 rejects requests on hosts outside its compile-time allowlist
   * unless trustHost is true. Defaults to true for self-hosted compose
   * deploys; operators behind an untrusted edge can pass false.
   */
  AUTH_TRUST_HOST?: boolean | undefined;
}

export function buildAuthConfig(db: Database, env: AuthEnv): NextAuthConfig {
  return {
    adapter: makeAdapter(db),
    secret: env.AUTH_SECRET,
    trustHost: env.AUTH_TRUST_HOST ?? true,
    session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },
    providers: buildProviders(env),
    callbacks: {
      async signIn({ user }) {
        const email = user.email;
        if (!email) return false;
        const decision = await decideSignUp(db, email, env);
        return decision.allowed;
      },
    },
    events: {
      async createUser({ user }) {
        if (!user.email || !user.id) return;

        const otherUser = await db.query.users.findFirst({
          where: ne(users.id, user.id),
        });
        const isFirstUser = !otherUser;

        const invite = await db.query.invites.findFirst({
          where: and(
            eq(invites.email, user.email),
            isNull(invites.acceptedAt),
            gt(invites.expiresAt, new Date()),
          ),
        });

        if (invite) {
          await db
            .insert(organizationMembers)
            .values({ orgId: invite.orgId, userId: user.id })
            .onConflictDoNothing();
          await db.insert(roleAssignments).values({
            userId: user.id,
            role: invite.role,
            scopeType: invite.scopeType,
            scopeId: invite.scopeId,
          });
          await db
            .update(invites)
            .set({ acceptedAt: new Date() })
            .where(eq(invites.id, invite.id));
          return;
        }

        if (isFirstUser && user.email === env.superAdminEmail) {
          const [org] = await db
            .insert(organizations)
            .values({ slug: env.defaultOrgSlug, name: env.defaultOrgName })
            .onConflictDoNothing()
            .returning();

          const resolvedOrg =
            org ??
            (await db.query.organizations.findFirst({
              where: eq(organizations.slug, env.defaultOrgSlug),
            }));

          if (resolvedOrg) {
            await db
              .insert(organizationMembers)
              .values({ orgId: resolvedOrg.id, userId: user.id })
              .onConflictDoNothing();
            await db.insert(roleAssignments).values({
              userId: user.id,
              role: "super_admin",
              scopeType: "global",
            });
          }
        }
      },
    },
    pages: { signIn: "/sign-in" },
  };
}
