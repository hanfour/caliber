import { z } from "zod";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { clientEvents, clientSessions, users } from "@caliber/db";
import { can } from "@caliber/auth";
import type { UserPermissions } from "@caliber/auth";
import { protectedProcedure, router } from "../procedures.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetBeforeCursor,
} from "./_keysetCursor.js";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime();

// Default lookback when the caller omits `from` — mirrors the usage router.
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

function resolveWindow(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return { from: fromDate, to: toDate };
}

// Telemetry sessions are usage data, so they reuse the usage.* RBAC surface
// rather than introducing a parallel permission (org admins already granted
// usage.read_org see them; a member reads their own).
function ensureCanReadOrg(perm: UserPermissions, orgId: string) {
  if (!can(perm, { type: "usage.read_org", orgId })) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

function ensureCanReadUser(
  perm: UserPermissions,
  orgId: string,
  targetUserId: string,
  callerUserId: string,
) {
  if (targetUserId === callerUserId) {
    if (!can(perm, { type: "usage.read_own" })) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return;
  }
  if (!can(perm, { type: "usage.read_user", orgId, targetUserId })) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

export const sessionsRouter = router({
  /**
   * Per-member telemetry aggregates for an org over a window: session count,
   * event count, first/last activity, and a claude-code/codex source split.
   * Powers the org Sessions page + the member-list activity column (#255).
   */
  orgSummary: protectedProcedure
    .input(
      z.object({
        orgId: uuid,
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      ensureCanReadOrg(ctx.perm, input.orgId);
      const { from, to } = resolveWindow(input.from, input.to);

      // Sessions grouped by member (+ source split) in the window.
      const sessionAgg = await ctx.db
        .select({
          userId: clientSessions.userId,
          email: users.email,
          name: users.name,
          sessionCount: sql<number>`count(*)::int`,
          firstActivity: sql<string | null>`min(${clientSessions.startedAt})`,
          lastActivity: sql<string | null>`max(${clientSessions.lastEventAt})`,
          claudeCode: sql<number>`count(*) filter (where ${clientSessions.sourceClient} = 'claude-code')::int`,
          codex: sql<number>`count(*) filter (where ${clientSessions.sourceClient} = 'codex')::int`,
        })
        .from(clientSessions)
        .innerJoin(users, eq(users.id, clientSessions.userId))
        .where(
          and(
            eq(clientSessions.orgId, input.orgId),
            gte(clientSessions.startedAt, from),
            lte(clientSessions.startedAt, to),
          ),
        )
        .groupBy(clientSessions.userId, users.email, users.name)
        .orderBy(desc(sql`count(*)`));

      // Event counts per member in the window (events carry orgId; join to
      // sessions for the member attribution).
      const eventAgg = await ctx.db
        .select({
          userId: clientSessions.userId,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(clientEvents)
        .innerJoin(clientSessions, eq(clientSessions.id, clientEvents.sessionId))
        .where(
          and(
            eq(clientEvents.orgId, input.orgId),
            gte(clientEvents.timestamp, from),
            lte(clientEvents.timestamp, to),
          ),
        )
        .groupBy(clientSessions.userId);

      const eventCountByUser = new Map(
        eventAgg.map((r) => [r.userId, r.eventCount]),
      );

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        members: sessionAgg.map((r) => ({
          userId: r.userId,
          email: r.email,
          name: r.name,
          sessionCount: r.sessionCount,
          eventCount: eventCountByUser.get(r.userId) ?? 0,
          firstActivity: r.firstActivity,
          lastActivity: r.lastActivity,
          sources: { "claude-code": r.claudeCode, codex: r.codex },
        })),
      };
    }),

  /**
   * Paginated session list for one member, newest first, with a per-session
   * event count.
   *
   * Cursor: a `(startedAt, id)` keyset cursor via the shared
   * `_keysetCursor` helper (see that file's header) — NOT a bare startedAt
   * ISO string. The original ISO-string cursor silently dropped rows: it
   * compared the raw `client_sessions.started_at` column (microsecond
   * precision) against a JS `Date` derived from the previous page's last
   * row (millisecond precision, floored), so any row whose true timestamp
   * fell in the truncated gap — ordinary under concurrent same-millisecond
   * session starts — was skipped with no signal (found in Task 9 review,
   * fixed here alongside the identical defect in usage.listRequests).
   */
  listForUser: protectedProcedure
    .input(
      z.object({
        orgId: uuid,
        userId: uuid,
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        cursor: z.string().min(1).max(500).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      ensureCanReadUser(ctx.perm, input.orgId, input.userId, ctx.user.id);
      const { from, to } = resolveWindow(input.from, input.to);
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      const cursor = input.cursor
        ? decodeKeysetCursor(input.cursor)
        : undefined;

      const rows = await ctx.db
        .select({
          id: clientSessions.id,
          sourceClient: clientSessions.sourceClient,
          cwd: clientSessions.cwd,
          gitBranch: clientSessions.gitBranch,
          cliVersion: clientSessions.cliVersion,
          startedAt: clientSessions.startedAt,
          lastEventAt: clientSessions.lastEventAt,
          // Full-precision cursor material — see _keysetCursor.ts. Never
          // used for display; only to build the next page's cursor, and
          // stripped out of the response below.
          startedAtText: sql<string>`${clientSessions.startedAt}::text`,
        })
        .from(clientSessions)
        .where(
          and(
            eq(clientSessions.orgId, input.orgId),
            eq(clientSessions.userId, input.userId),
            gte(clientSessions.startedAt, from),
            lte(clientSessions.startedAt, to),
            cursor
              ? keysetBeforeCursor(
                  clientSessions.startedAt,
                  clientSessions.id,
                  "text",
                  cursor,
                )
              : undefined,
          ),
        )
        .orderBy(desc(clientSessions.startedAt), desc(clientSessions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeKeysetCursor({ ts: last.startedAtText, id: last.id })
          : null;

      // Per-session event counts for the page (separate query, merged in JS —
      // a correlated subquery loses drizzle's table qualifier and collides
      // client_events.id with client_sessions.id).
      const pageIds = page.map((s) => s.id);
      const counts = pageIds.length
        ? await ctx.db
            .select({
              sessionId: clientEvents.sessionId,
              eventCount: sql<number>`count(*)::int`,
            })
            .from(clientEvents)
            .where(inArray(clientEvents.sessionId, pageIds))
            .groupBy(clientEvents.sessionId)
        : [];
      const countBySession = new Map(counts.map((c) => [c.sessionId, c.eventCount]));

      return {
        sessions: page.map((s) => ({
          id: s.id,
          sourceClient: s.sourceClient,
          cwd: s.cwd,
          gitBranch: s.gitBranch,
          cliVersion: s.cliVersion,
          startedAt: s.startedAt,
          lastEventAt: s.lastEventAt,
          eventCount: countBySession.get(s.id) ?? 0,
        })),
        nextCursor,
      };
    }),
});
