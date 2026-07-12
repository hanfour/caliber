import type { FastifyPluginAsync } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { and, asc, eq, gte, ilike, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { can, resolvePermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import {
  clientEvents,
  clientSessions,
  organizationMembers,
  organizations,
  users,
} from "@caliber/db";
import { mapEventsToRows } from "@caliber/evaluator/telemetry";
import { writeAudit } from "../services/audit.js";
import { AUDIT_ACTIONS } from "../services/auditActions.js";
import { resolveReportRubric } from "../services/resolveReportRubric.js";
import { cliAccessKey, hashCliAccessToken } from "./deviceAuth.js";

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20_000;
const MAX_BUNDLE_CONTENT_BYTES = 25 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bodySchema = z.object({
  org: z.string().min(1).max(255),
  member: z.string().min(1).max(320),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  locale: z.enum(["en", "zh-Hant", "ja"]).optional(),
});

interface CliPrincipal {
  userId: string;
  orgId: string;
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return token.startsWith("cct_") ? token : null;
}

export function cliAdminReportRoutes(
  env: ServerEnv,
  redis: Redis,
): FastifyPluginAsync {
  return async (fastify) => {
    await fastify.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.ip,
    });

    fastify.post("/v1/cli/admin/report-bundle", async (request, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const token = bearerToken(request.headers.authorization);
      if (!token) {
        reply.code(401);
        return { error: "unauthorized" };
      }
      const rawPrincipal = await redis.get(cliAccessKey(hashCliAccessToken(token)));
      let principal: CliPrincipal | null = null;
      try {
        principal = rawPrincipal ? (JSON.parse(rawPrincipal) as CliPrincipal) : null;
      } catch {
        principal = null;
      }
      if (!principal?.userId || !principal.orgId) {
        reply.code(401);
        return { error: "expired_access_token" };
      }
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const periodStart = new Date(parsed.data.period_start);
      const periodEnd = new Date(parsed.data.period_end);
      const duration = periodEnd.getTime() - periodStart.getTime();
      if (duration <= 0 || duration > MAX_PERIOD_MS) {
        reply.code(400);
        return { error: "invalid_period", max_days: 31 };
      }

      const orgWhere = uuidPattern.test(parsed.data.org)
        ? eq(organizations.id, parsed.data.org)
        : eq(organizations.slug, parsed.data.org);
      const [org] = await fastify.db
        .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
        .from(organizations)
        .where(and(orgWhere, isNull(organizations.deletedAt)))
        .limit(1);
      if (!org) {
        reply.code(404);
        return { error: "not_found" };
      }
      const permissions = await resolvePermissions(fastify.db, principal.userId);
      if (!can(permissions, { type: "report.read_org", orgId: org.id })) {
        reply.code(403);
        return { error: "forbidden" };
      }

      const memberWhere = uuidPattern.test(parsed.data.member)
        ? eq(users.id, parsed.data.member)
        : ilike(users.email, parsed.data.member);
      const [member] = await fastify.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.orgId, org.id), memberWhere))
        .limit(1);
      if (!member) {
        reply.code(404);
        return { error: "member_not_found" };
      }

      const joinedEvents = await fastify.db
        .select({
          sessionId: clientEvents.sessionId,
          eventId: clientEvents.eventId,
          role: clientEvents.role,
          content: clientEvents.content,
          inputTokens: clientEvents.inputTokens,
          outputTokens: clientEvents.outputTokens,
          cacheReadTokens: clientEvents.cacheReadTokens,
          cacheCreationTokens: clientEvents.cacheCreationTokens,
          sourceClient: clientSessions.sourceClient,
          modelProvider: clientSessions.modelProvider,
        })
        .from(clientEvents)
        .innerJoin(clientSessions, eq(clientSessions.id, clientEvents.sessionId))
        .where(
          and(
            eq(clientEvents.orgId, org.id),
            eq(clientSessions.orgId, org.id),
            eq(clientSessions.userId, member.id),
            gte(clientEvents.timestamp, periodStart),
            lt(clientEvents.timestamp, periodEnd),
          ),
        )
        .orderBy(asc(clientEvents.sessionId), asc(clientEvents.timestamp))
        .limit(MAX_EVENTS + 1);
      if (joinedEvents.length > MAX_EVENTS) {
        reply.code(413);
        return { error: "period_too_large", max_events: MAX_EVENTS };
      }

      let contentBytes = 0;
      const sessionMap = new Map<string, { id: string; sourceClient: string | null; modelProvider: string | null }>();
      const events = joinedEvents.map(({ sourceClient, modelProvider, ...event }) => {
        sessionMap.set(event.sessionId, { id: event.sessionId, sourceClient, modelProvider });
        contentBytes += Buffer.byteLength(JSON.stringify(event.content ?? null));
        return event;
      });
      if (contentBytes > MAX_BUNDLE_CONTENT_BYTES) {
        reply.code(413);
        return { error: "bundle_too_large", max_bytes: MAX_BUNDLE_CONTENT_BYTES };
      }

      const sessions = [...sessionMap.values()];
      const rows = mapEventsToRows(sessions, events);
      const resolved = await resolveReportRubric(
        fastify.db,
        org.id,
        parsed.data.locale,
      );
      await writeAudit(fastify.db, {
        actorUserId: principal.userId,
        action: AUDIT_ACTIONS.REPORT_CLI_BUNDLE_EXPORTED,
        targetType: "user",
        targetId: member.id,
        orgId: org.id,
        metadata: {
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          eventCount: events.length,
          turnCount: rows.transcriptEventCount,
          rubricId: resolved.rubricId,
        },
      });
      return {
        generated_at: new Date().toISOString(),
        org,
        member,
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        rubric: resolved.rubric,
        rubric_meta: {
          id: resolved.rubricId,
          version: resolved.rubricVersion,
          source: resolved.source,
        },
        usage_rows: rows.usageRows,
        body_rows: rows.bodyRows,
        source: { session_count: sessions.length, event_count: events.length, turn_count: rows.transcriptEventCount },
      };
    });
  };
}
