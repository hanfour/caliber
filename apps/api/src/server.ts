import Fastify from "fastify";
import { LOG_REDACT_PATHS } from "@caliber/gateway-core";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { parseServerEnv } from "@caliber/config/env";
import { setGlobalLocaleErrorMap } from "@caliber/i18n-validation/server";
import { healthRoutes } from "./rest/health.js";
import { deviceAuthRoutes } from "./rest/deviceAuth.js";
import { cliAdminReportRoutes } from "./rest/cliAdminReport.js";
import { devicesEnrollRoutes } from "./rest/devicesEnroll.js";
import { devicesRevokeSelfRoutes } from "./rest/devicesRevokeSelf.js";
import { ingestRoutes } from "./rest/ingest.js";
import { redactionSetRoutes } from "./rest/redactionSet.js";
import { agentConfigRoutes } from "./rest/agentConfig.js";
import { startPartitionRollForwardCron } from "./services/clientEventsPartitions.js";
import { cookiesPlugin } from "./plugins/cookies.js";
import { authPlugin } from "./plugins/auth.js";
import { appRouter } from "./trpc/router.js";
import { createContextFactory } from "./trpc/context.js";
import { buildTrpcErrorLogPayload } from "./trpc/onErrorLog.js";
import { trpcTooManyRequestsBody } from "./trpc/rateLimitError.js";
import {
  EVALUATOR_QUEUE_NAME,
  EVALUATOR_QUEUE_PREFIX,
} from "./trpc/routers/reports.js";

// When the gateway is disabled, no router actually reaches Redis (every
// gateway-aware router short-circuits to NOT_FOUND via ensureGatewayEnabled).
// We still need to satisfy the TrpcContext.redis type, so we hand back a proxy
// that throws loudly if any method is invoked. This means a regression that
// removes the ENABLE_GATEWAY guard would surface immediately at runtime
// instead of silently corrupting state.
function makeDisabledRedis(): Redis {
  const handler: ProxyHandler<Redis> = {
    get(_target, prop) {
      throw new Error(
        `redis disabled (ENABLE_GATEWAY=false); attempted access: ${String(
          prop,
        )}`,
      );
    },
  };
  return new Proxy({} as Redis, handler);
}

export async function buildServer() {
  const env = parseServerEnv();
  await setGlobalLocaleErrorMap();
  // Trust X-Forwarded-For only from configured proxy CIDRs. Without this,
  // req.ip resolves to the reverse proxy's address — rate limiting fall
  // back keyed on req.ip would collapse all traffic to a single bucket.
  const trustedProxies = env.GATEWAY_TRUSTED_PROXIES.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
      // Phase 3 #4-a — credential redaction at the structured-log layer.
      // Same path list the gateway uses; free-form strings (err.message)
      // still need `safeErrorMessage()` at the call site.
      redact: { paths: [...LOG_REDACT_PATHS], censor: "[REDACTED]" },
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: trustedProxies.length === 0 ? false : trustedProxies,
  });

  await app.register(cookiesPlugin);
  await app.register(authPlugin, { env });
  await app.register(healthRoutes);
  await app.register(devicesEnrollRoutes(env));
  await app.register(devicesRevokeSelfRoutes(env));
  await app.register(ingestRoutes(env));
  await app.register(redactionSetRoutes(env));
  await app.register(agentConfigRoutes(env));

  // Daily roll-forward for client_events monthly partitions. Runs immediately
  // on boot so a fresh deploy is safe even if the daily timer hasn't ticked.
  // Gated on ENABLE_GATEWAY: a deploy with the daemon path off has no ingest
  // and so no need to maintain partitions beyond what 0013 already created.
  if (env.ENABLE_GATEWAY) {
    const partitionCron = startPartitionRollForwardCron({
      db: app.db,
      logger: {
        info: (obj, msg) => app.log.info(obj, msg),
        error: (obj, msg) => app.log.error(obj, msg),
      },
    });
    app.addHook("onClose", async () => {
      partitionCron.stop();
    });
  }

  // Dynamically load /test-seed only when all gating conditions hold. This
  // lets production images strip dist/rest/testSeed.js entirely — defense in
  // depth on top of the env + token checks inside the plugin itself.
  if (
    env.NODE_ENV !== "production" &&
    env.ENABLE_TEST_SEED === true &&
    !!env.TEST_SEED_TOKEN
  ) {
    const { testSeedRoutes } = await import("./rest/testSeed.js");
    await app.register(testSeedRoutes(env));
  }

  // Share the gateway's `caliber:gw:` namespace so admin-issued api-key reveal
  // tokens stashed by the api land in the same keyspace the gateway can see.
  // env.REDIS_URL is required at parse time when ENABLE_GATEWAY=true.
  let redis: Redis;
  if (env.ENABLE_GATEWAY) {
    redis = new Redis(env.REDIS_URL!, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      keyPrefix: "caliber:gw:",
    });
    redis.on("error", (err: Error) => {
      app.log.warn({ err: err.message }, "redis error");
    });
    app.addHook("onClose", async () => {
      await redis.quit().catch(() => {});
    });
  } else {
    redis = makeDisabledRedis();
  }

  // RFC 8628-style device-authorization endpoints for `caliber login`.
  // Registered after `redis` exists; when ENABLE_GATEWAY=false both handlers
  // 404 before ever touching the throwing disabled-redis proxy.
  await app.register(deviceAuthRoutes(env, redis));
  await app.register(cliAdminReportRoutes(env, redis));

  // Instantiate the evaluator BullMQ queue when the feature flag is on.
  // Skipped entirely when ENABLE_EVALUATOR=false or REDIS_URL is absent —
  // reports.rerun will gracefully return testMode:true in those cases.
  let evaluatorQueue: Queue | undefined;
  if (env.ENABLE_EVALUATOR && env.REDIS_URL) {
    const evaluatorRedis = new Redis(env.REDIS_URL, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
    });
    evaluatorRedis.on("error", (err: Error) => {
      app.log.warn({ err: err.message }, "evaluator redis error");
    });
    evaluatorQueue = new Queue(EVALUATOR_QUEUE_NAME, {
      prefix: EVALUATOR_QUEUE_PREFIX,
      connection: evaluatorRedis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 86400, count: 500 },
        removeOnFail: { age: 7 * 86400 },
      },
    });
    app.addHook("onClose", async () => {
      await evaluatorQueue?.close();
    });
  }

  // /trpc rate limit: API_TRPC_RPM_LIMIT/min PER authenticated user (fall back
  // to IP only when unauthenticated). 0 disables. The 429 body is tRPC-shaped
  // (see trpcTooManyRequestsBody) so the web client gets a clean
  // TOO_MANY_REQUESTS error instead of "Unable to transform response". (#193)
  await app.register(
    async (scope) => {
      if (env.API_TRPC_RPM_LIMIT > 0) {
        await scope.register(rateLimit, {
          max: env.API_TRPC_RPM_LIMIT,
          timeWindow: "1 minute",
          keyGenerator: (req) => req.user?.id ?? req.ip,
          errorResponseBuilder: (req, context) =>
            trpcTooManyRequestsBody(req, context.after),
        });
      }
      await scope.register(fastifyTRPCPlugin, {
        prefix: "",
        trpcOptions: {
          router: appRouter,
          createContext: createContextFactory({ env, redis, evaluatorQueue }),
          // errorFormatter is set on initTRPC.create() in trpc/procedures.ts —
          // setting it here on the adapter is silently ignored by tRPC v11.
          onError: ({
            error,
            path,
            input,
          }: {
            error: { code: string; message: string; cause?: unknown };
            path?: string;
            input?: unknown;
          }) => {
            // Surface tRPC errors (esp. Zod input validation) at WARN in api.log
            // so CI failures have diagnosable context. In production we omit
            // `input` entirely — pino redact paths catch known secret keys but
            // a new procedure can introduce a token-shaped field name the
            // redact list does not yet cover. See trpc/onErrorLog.ts.
            app.log.warn(
              buildTrpcErrorLogPayload({ error, path, input }, env),
              "trpc error",
            );
          },
        },
      });
    },
    { prefix: "/trpc" },
  );

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
