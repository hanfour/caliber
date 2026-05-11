import { z } from "zod";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { usageLogs } from "@caliber/db";
import { can, type Action } from "@caliber/auth";
import type { UserPermissions } from "@caliber/auth";
import { protectedProcedure, router } from "../procedures.js";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime();

// Default lookback window when the caller omits `from`. 30 days mirrors the
// Plan 4A spec for the usage UI default range.
const DEFAULT_LOOKBACK_DAYS = 30;

// Hard cap on `pageSize` for `list`. Anything higher would let a single
// request scan an unbounded slice of usage_logs (which can grow large).
const MAX_PAGE_SIZE = 200;

// Cap how many byModel groups we surface in `summary`. The real top-N is
// almost always <50; capping keeps the response payload bounded for orgs
// that fan out across many requested models.
const MAX_BY_MODEL_GROUPS = 50;

// Discriminated scope: tags every query with a kind (own / user / team / org)
// plus the IDs the WHERE filter and the RBAC check both need. Keeping the IDs
// REQUIRED on the scope (rather than free-floating optional fields) means we
// can never accidentally compute a permission decision against a different
// org/team than the rows we filter on.
const scopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("own") }),
  z.object({
    type: z.literal("user"),
    userId: uuid,
    orgId: uuid,
  }),
  z.object({
    type: z.literal("team"),
    teamId: uuid,
    orgId: uuid,
  }),
  z.object({
    type: z.literal("org"),
    orgId: uuid,
  }),
]);

type Scope = z.infer<typeof scopeSchema>;

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Map a scope to the RBAC action that authorizes reading rows in that scope.
// Done as a switch (not a Record) because each branch needs its own typed
// payload pulled from the discriminated union.
function actionForScope(scope: Scope): Action {
  switch (scope.type) {
    case "own":
      return { type: "usage.read_own" };
    case "user":
      return {
        type: "usage.read_user",
        orgId: scope.orgId,
        targetUserId: scope.userId,
      };
    case "team":
      return {
        type: "usage.read_team",
        orgId: scope.orgId,
        teamId: scope.teamId,
      };
    case "org":
      return { type: "usage.read_org", orgId: scope.orgId };
  }
}

// Manual permission check — `permissionProcedure` doesn't compose cleanly with
// a discriminated-union input because the resolver loses scope narrowing. We
// FORBIDDEN here (NOT NOT_FOUND) since the caller is authenticated and the
// scope IDs were explicitly chosen by them; surfacing the right error helps
// the UI distinguish "no access" from "no data".
function ensureCanReadScope(perm: UserPermissions, scope: Scope) {
  if (!can(perm, actionForScope(scope))) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

// Compose the scope-specific WHERE predicate. Returns an array so the caller
// can append the time-window predicate without re-flattening.
function scopeWhere(scope: Scope, callerUserId: string): SQL[] {
  switch (scope.type) {
    case "own":
      // No orgId filter: returns ALL rows the caller authored across every
      // org. For v0.2.0 / single-org users this is equivalent to scoping by
      // orgId (they only have one). For super_admins or future multi-org
      // users, this reads as "my own requests anywhere" — semantically
      // correct for "own".
      return [eq(usageLogs.userId, callerUserId)];
    case "user":
      return [
        eq(usageLogs.userId, scope.userId),
        eq(usageLogs.orgId, scope.orgId),
      ];
    case "team":
      return [
        eq(usageLogs.teamId, scope.teamId),
        eq(usageLogs.orgId, scope.orgId),
      ];
    case "org":
      return [eq(usageLogs.orgId, scope.orgId)];
  }
}

// Resolve a from/to window with sensible defaults. Both ends are inclusive
// (`>=` / `<=`) so callers can paginate by time without losing rows on the
// boundary.
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

// Subset of usage_logs columns surfaced by `list`. PII columns (userAgent,
// ipAddress) and the oversized failedAccountIds array are intentionally
// omitted — they're useful only for incident response, not drill-down.
//
// `id` cast to text: drizzle returns Postgres `bigint` as a JS BigInt,
// which the default JSON serializer in tRPC trips on with
// `Do not know how to serialize a BigInt`. Cast at the SQL boundary
// rather than wrapping every consumer in BigInt-aware serialization;
// the id is only used as an opaque key on the client (drill-down,
// React keys), so a string is fine.
const listColumns = {
  id: sql<string>`${usageLogs.id}::text`.as("id"),
  requestId: usageLogs.requestId,
  userId: usageLogs.userId,
  apiKeyId: usageLogs.apiKeyId,
  accountId: usageLogs.accountId,
  orgId: usageLogs.orgId,
  teamId: usageLogs.teamId,
  requestedModel: usageLogs.requestedModel,
  upstreamModel: usageLogs.upstreamModel,
  platform: usageLogs.platform,
  surface: usageLogs.surface,
  inputTokens: usageLogs.inputTokens,
  outputTokens: usageLogs.outputTokens,
  cacheCreationTokens: usageLogs.cacheCreationTokens,
  cacheReadTokens: usageLogs.cacheReadTokens,
  inputCost: usageLogs.inputCost,
  outputCost: usageLogs.outputCost,
  cacheCreationCost: usageLogs.cacheCreationCost,
  cacheReadCost: usageLogs.cacheReadCost,
  totalCost: usageLogs.totalCost,
  stream: usageLogs.stream,
  statusCode: usageLogs.statusCode,
  durationMs: usageLogs.durationMs,
  firstTokenMs: usageLogs.firstTokenMs,
  bufferReleasedAtMs: usageLogs.bufferReleasedAtMs,
  upstreamRetries: usageLogs.upstreamRetries,
  createdAt: usageLogs.createdAt,
} as const;

export const usageRouter = router({
  // Aggregate totals + per-model breakdown over a scope and time window.
  // Two queries (totals + byModel) rather than one with a window function so
  // each can use the appropriate index — the totals query benefits from
  // `(userId|orgId|teamId, createdAt)` indexes; the byModel query benefits
  // from grouping on `requested_model`.
  summary: protectedProcedure
    .input(
      z.object({
        scope: scopeSchema,
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      ensureCanReadScope(ctx.perm, input.scope);

      const { from, to } = resolveWindow(input.from, input.to);
      const where = and(
        ...scopeWhere(input.scope, ctx.user.id),
        gte(usageLogs.createdAt, from),
        lte(usageLogs.createdAt, to),
      );

      // Totals: COALESCE so an empty window returns "0" decimals (not null).
      // Cast count to int4 explicitly — Postgres returns COUNT(*) as int8,
      // which Drizzle would otherwise hand back as a string.
      const [totals] = await ctx.db
        .select({
          totalRequests: sql<number>`COUNT(*)::int`,
          totalCostUsd: sql<string>`COALESCE(SUM(${usageLogs.totalCost}), 0)::text`,
          totalInputTokens: sql<number>`COALESCE(SUM(${usageLogs.inputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`COALESCE(SUM(${usageLogs.outputTokens}), 0)::int`,
          totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageLogs.cacheCreationTokens}), 0)::int`,
          totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageLogs.cacheReadTokens}), 0)::int`,
        })
        .from(usageLogs)
        .where(where);

      const byModel = await ctx.db
        .select({
          model: usageLogs.requestedModel,
          requests: sql<number>`COUNT(*)::int`,
          costUsd: sql<string>`COALESCE(SUM(${usageLogs.totalCost}), 0)::text`,
          inputTokens: sql<number>`COALESCE(SUM(${usageLogs.inputTokens}), 0)::int`,
          outputTokens: sql<number>`COALESCE(SUM(${usageLogs.outputTokens}), 0)::int`,
        })
        .from(usageLogs)
        .where(where)
        .groupBy(usageLogs.requestedModel)
        .orderBy(desc(sql`SUM(${usageLogs.totalCost})`))
        .limit(MAX_BY_MODEL_GROUPS);

      // Decimal columns intentionally returned as strings (the canonical
      // Drizzle representation for `numeric(20, 10)`). Converting to JS
      // number here would lose precision for high-cost orgs and break
      // downstream sums in the UI. The web client renders them via a
      // bigdecimal library.
      return {
        totalRequests: totals?.totalRequests ?? 0,
        totalCostUsd: totals?.totalCostUsd ?? "0",
        totalInputTokens: totals?.totalInputTokens ?? 0,
        totalOutputTokens: totals?.totalOutputTokens ?? 0,
        totalCacheCreationTokens: totals?.totalCacheCreationTokens ?? 0,
        totalCacheReadTokens: totals?.totalCacheReadTokens ?? 0,
        byModel,
      };
    }),

  // Paginated, time-ordered drill-down. `totalCount` is computed with a
  // separate COUNT(*) query — accurate but O(scan) on the indexed slice.
  // For multi-million-row scopes we may want a `hasMore` cursor instead;
  // for the Plan 4A admin UI the correctness of an absolute page count
  // matters more than micro-optimization.
  list: protectedProcedure
    .input(
      z.object({
        scope: scopeSchema,
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      ensureCanReadScope(ctx.perm, input.scope);

      const { from, to } = resolveWindow(input.from, input.to);
      const where = and(
        ...scopeWhere(input.scope, ctx.user.id),
        gte(usageLogs.createdAt, from),
        lte(usageLogs.createdAt, to),
      );

      const offset = (input.page - 1) * input.pageSize;

      const [items, countRow] = await Promise.all([
        ctx.db
          .select(listColumns)
          .from(usageLogs)
          .where(where)
          .orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
          .limit(input.pageSize)
          .offset(offset),
        ctx.db
          .select({ totalCount: sql<number>`COUNT(*)::int` })
          .from(usageLogs)
          .where(where)
          .then((r) => r[0]),
      ]);

      return {
        items,
        page: input.page,
        pageSize: input.pageSize,
        totalCount: countRow?.totalCount ?? 0,
      };
    }),
});
