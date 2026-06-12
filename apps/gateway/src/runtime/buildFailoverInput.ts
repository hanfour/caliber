// Route-facing `RunFailoverInput` builder (BYOK isolation hardening).
//
// Every `/v1/*` route handler that dispatches through `runFailover` reads the
// SAME six fields off the authenticated request — `orgId`, `teamId`, `groupId`,
// `routingPolicy`, `userId`, `platform` — all derivable from `req.apiKey` +
// `req.gwGroupContext`. BYOK P1 threaded `routingPolicy` + `userId` onto all 13
// callsites by hand; ONE site was missed, silently downgrading an "own" key to
// `pool` (org-pool leak). This builder centralises that read so:
//
//   * the six req-derived fields (incl. routingPolicy/userId) are populated in
//     ONE place, and
//   * the per-call object handed in by a route CANNOT name those fields (they
//     are `Omit`-ed from `RouteFailoverFields`), so a future site physically
//     cannot omit OR mis-set them — combined with `routingPolicy`/`userId` being
//     REQUIRED on `RunFailoverInput`, omission is a COMPILE error.

import type { FastifyRequest } from "fastify";
import type { Database } from "@caliber/db";
import type { RunFailoverInput } from "./failoverLoop.js";

/**
 * The per-call slice of `RunFailoverInput` a route handler still supplies:
 * everything EXCEPT `db` (passed explicitly) and the six fields the builder
 * derives from the request. Notably excludes `routingPolicy` + `userId`, so a
 * route handler cannot pass (or forget) them — the builder owns them.
 */
export type RouteFailoverFields<T> = Omit<
  RunFailoverInput<T>,
  | "db"
  | "orgId"
  | "teamId"
  | "groupId"
  | "routingPolicy"
  | "userId"
  | "platform"
  | "authHealth"
>;

/**
 * Build a complete `RunFailoverInput` for a route handler.
 *
 * Reads `req.apiKey` (orgId/teamId/groupId/userId) and `req.gwGroupContext`
 * (routingPolicy/platform); the caller supplies only the per-call fields
 * (`maxSwitches`, `attempt`, and any optional scheduler/sticky/redis hooks).
 *
 * Fails fast (rather than silently degrading) if the request was not
 * authenticated + group-resolved, which should be impossible past the
 * apiKeyAuth + groupContext middleware but is asserted at the boundary.
 */
export function buildFailoverInput<T>(
  req: FastifyRequest,
  db: Database,
  fields: RouteFailoverFields<T>,
): RunFailoverInput<T> {
  const apiKey = req.apiKey;
  if (!apiKey) {
    throw new Error(
      "buildFailoverInput: req.apiKey is missing (apiKeyAuth middleware did not run)",
    );
  }
  const ctx = req.gwGroupContext;
  if (!ctx) {
    throw new Error(
      "buildFailoverInput: req.gwGroupContext is missing (groupContext middleware did not run)",
    );
  }

  // Assemble the api_key credential-health deps from the Fastify instance's
  // decorations (verified against server.ts / plugin augmentations:
  // app.redis / app.gwMetrics / app.env / app.log). Route callsites are
  // UNCHANGED — they pass only `fields`; this read happens here so the loop's
  // auth-health hooks (next task) don't need deps threaded through every route.
  // No redis (e.g. hand-built unit-test reqs) → undefined, and the loop no-ops.
  const app = req.server;
  const authHealth = app?.redis
    ? {
        redis: app.redis,
        maxFail: app.env.GATEWAY_UPSTREAM_AUTH_MAX_FAIL,
        backoffSec: app.env.GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC,
        graceSec: app.env.GATEWAY_UPSTREAM_AUTH_GRACE_SEC,
        metrics: {
          authFailedTotal: app.gwMetrics.upstreamAuthFailedTotal,
          credentialDegradedTotal: app.gwMetrics.upstreamCredentialDegradedTotal,
        },
        logger: app.log,
      }
    : undefined;

  return {
    db,
    orgId: apiKey.orgId,
    teamId: apiKey.teamId,
    groupId: apiKey.groupId ?? null,
    routingPolicy: ctx.policy,
    userId: apiKey.userId,
    platform: ctx.platform,
    authHealth,
    ...fields,
  };
}
