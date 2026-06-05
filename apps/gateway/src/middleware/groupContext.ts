// Fastify preHandler that resolves the AccountGroup for the
// authenticated request and attaches it to `req.gwGroupContext`
// (Plan 5A Part 8, Task 8.2).
//
// Ordering: must register AFTER `apiKeyAuthPlugin` so `req.apiKey` is
// populated. Public paths and unauthenticated requests are skipped —
// `req.apiKey == null` after apiKeyAuth means either /health, /metrics,
// or auth already 401'd, so there's nothing to resolve.

import fp from "fastify-plugin";
import {
  resolveGroupContext,
  type GroupContext,
} from "../runtime/groupDispatch.js";
import { platformForGatewayRoute } from "../routes/surfacePlatform.js";

declare module "fastify" {
  interface FastifyRequest {
    gwGroupContext: GroupContext | null;
  }
}

export const groupContextPlugin = fp(
  async (fastify) => {
    fastify.decorateRequest("gwGroupContext", null);

    fastify.addHook("preHandler", async (req, reply) => {
      if (!req.apiKey) return; // public path or already-failed auth

      // Non-pool (BYOK) keys have no group; their platform is derived from
      // the request surface. Resolve it here (the plugin has `req`) and
      // thread it into the resolver. For pool keys we skip this entirely so
      // the `throw on unknown route` can't fire on non-upstream paths.
      const policy = req.apiKey.routingPolicy;
      const surfacePlatform =
        policy === "pool" ? undefined : platformForGatewayRoute(req);

      const ctx = await resolveGroupContext(fastify.db, {
        orgId: req.apiKey.orgId,
        groupId: req.apiKey.groupId,
        policy,
        surfacePlatform,
      });
      if (!ctx) {
        reply.code(403).send({ error: "group_not_found_or_disabled" });
        return reply;
      }
      req.gwGroupContext = ctx;
    });
  },
  {
    name: "groupContextPlugin",
    // Reads `fastify.db` + `req.apiKey`; reorder breaks loud here
    // instead of silently producing wrong-state requests.
    dependencies: ["dbPlugin", "apiKeyAuthPlugin"],
  },
);
