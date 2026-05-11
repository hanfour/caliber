import type { FastifyReply, FastifyRequest } from "fastify";
import { can, type Action } from "@caliber/auth";

type ActionResolver = (req: FastifyRequest) => Action;

export function requirePerm(resolver: ActionResolver) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !req.perm) {
      reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Not signed in",
          requestId: req.id,
        },
      });
      return;
    }
    const action = resolver(req);
    if (!can(req.perm, action)) {
      reply.code(403).send({
        error: {
          code: "FORBIDDEN",
          message: "Insufficient permissions",
          requestId: req.id,
        },
      });
      return;
    }
  };
}
