import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Database } from "@caliber/db";
import type { UserPermissions } from "@caliber/auth";
import type { ServerEnv } from "@caliber/config";
import type { Locale } from "@caliber/i18n-validation";
import { LOCALE_COOKIE, resolveLocale } from "@caliber/i18n-validation";
import type { EvaluatorQueue } from "./routers/reports.js";

// Fastify module augmentation for decorators set up by the api plugins.
// Declared here (in addition to plugins/auth.ts) so that downstream consumers
// of `@caliber/api/trpc` — which only import this file's type graph — pick it up.
declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
    perm: UserPermissions | null;
  }
  interface FastifyInstance {
    db: Database;
  }
}

// Subset of the Fastify/pino logger surface we expose on the trpc context.
// Pick'd intentionally: routers only need leveled writes — we don't want
// `child()`, `level=`, or other surface that would couple tRPC handlers to
// pino internals (and would make it harder to swap loggers in tests).
export type TrpcLogger = Pick<
  FastifyBaseLogger,
  "warn" | "info" | "error" | "debug"
>;

export interface TrpcContext {
  db: Database;
  user: { id: string; email: string } | null;
  perm: UserPermissions | null;
  reqId: string;
  locale: Locale;
  env: ServerEnv;
  // Shared with the gateway via the `caliber:gw:` keyPrefix so admin-issued
  // api-key reveal-token stashes are written/read from the same namespace.
  // When ENABLE_GATEWAY=false, this is a placeholder client whose methods
  // throw on use — the routers' ENABLE_GATEWAY guard short-circuits before
  // any redis call is reached.
  redis: Redis;
  // Source IP of the inbound request, used for audit fields (e.g.
  // api_keys.revealed_by_ip). Null when the caller is created outside an
  // HTTP request (e.g. the test harness).
  ipAddress: string | null;
  // Per-request structured logger. In HTTP context this is `req.log` (a pino
  // child with the reqId already bound). Tests inject a noop logger so they
  // don't pollute test output with router-internal warnings.
  logger: TrpcLogger;
  // BullMQ Queue for evaluator jobs. Undefined when ENABLE_EVALUATOR=false or
  // no REDIS_URL is configured (e.g. test mode without a queue). The
  // reports.rerun handler falls back to testMode when undefined.
  evaluatorQueue?: EvaluatorQueue;
}

export interface CreateContextDeps {
  env: ServerEnv;
  redis: Redis;
  evaluatorQueue?: EvaluatorQueue;
}

// Factory: bind the parsed env + shared redis client at server-startup time,
// then return the actual createContext callback that fastify-trpc will invoke
// per request. This avoids re-parsing env / re-allocating clients on every
// request.
export function createContextFactory(deps: CreateContextDeps) {
  return async function createContext(opts: {
    req: FastifyRequest;
    res: FastifyReply;
  }): Promise<TrpcContext> {
    return {
      db: opts.req.server.db,
      user: opts.req.user,
      perm: opts.req.perm,
      reqId: opts.req.id,
      locale: resolveLocale({
        cookie: opts.req.cookies[LOCALE_COOKIE],
        acceptLanguage: opts.req.headers["accept-language"] ?? null,
      }),
      env: deps.env,
      redis: deps.redis,
      ipAddress: opts.req.ip ?? null,
      // req.log is a pino child with the reqId already bound — exactly what
      // we want for per-request structured logging from inside resolvers.
      logger: opts.req.log,
      evaluatorQueue: deps.evaluatorQueue,
    };
  };
}
