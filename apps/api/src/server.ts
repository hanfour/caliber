import Fastify from "fastify";
import { LOG_REDACT_PATHS } from "@caliber/gateway-core";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { parseServerEnv } from "@caliber/config/env";
import {
  setGlobalLocaleErrorMap,
  getValidationMessagesSync,
  translateValidationKey,
  DEFAULT_LOCALE,
  type Locale,
} from "@caliber/i18n-validation/server";
import { healthRoutes } from "./rest/health.js";
import { cookiesPlugin } from "./plugins/cookies.js";
import { authPlugin } from "./plugins/auth.js";
import { appRouter } from "./trpc/router.js";
import { createContextFactory } from "./trpc/context.js";
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
  });

  await app.register(cookiesPlugin);
  await app.register(authPlugin, { env });
  await app.register(healthRoutes);

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

  // /trpc with rate limit 600/min/user (fall back to IP if no user)
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        max: 600,
        timeWindow: "1 minute",
        keyGenerator: (req) => req.user?.id ?? req.ip,
      });
      await scope.register(fastifyTRPCPlugin, {
        prefix: "",
        trpcOptions: {
          router: appRouter,
          createContext: createContextFactory({ env, redis, evaluatorQueue }),
          // Translate `validation.*`-prefixed key messages in Zod issues
          // before they leave the server. Required because Zod's
          // `makeIssue()` short-circuits the global errorMap whenever a
          // schema supplies an explicit `message` (e.g.
          // `.min(1, "validation.custom.shared.nameRequired")`), so the
          // raw key would otherwise reach the wire. The wrapper is
          // idempotent — pass-through for non-Zod errors or when the
          // messages cache hasn't loaded yet.
          errorFormatter: ({
            shape,
            ctx,
          }: {
            shape: {
              message?: string;
              data?: unknown;
              [k: string]: unknown;
            };
            ctx?: { locale?: Locale } | undefined;
          }) => {
            const locale = ctx?.locale ?? DEFAULT_LOCALE;
            const messages = getValidationMessagesSync(locale);
            if (!messages) return shape;

            const flattened = shape.data as
              | {
                  zodError?: {
                    fieldErrors?: Record<string, string[] | undefined>;
                    formErrors?: string[];
                  };
                  [k: string]: unknown;
                }
              | undefined;

            let translatedData: unknown = shape.data;
            if (flattened?.zodError) {
              const fe = flattened.zodError.fieldErrors ?? {};
              const newFieldErrors: Record<string, string[]> = {};
              for (const [field, errs] of Object.entries(fe)) {
                newFieldErrors[field] = (errs ?? []).map((m) =>
                  translateValidationKey(messages, m),
                );
              }
              const newFormErrors = (flattened.zodError.formErrors ?? []).map(
                (m) => translateValidationKey(messages, m),
              );
              translatedData = {
                ...flattened,
                zodError: {
                  ...flattened.zodError,
                  fieldErrors: newFieldErrors,
                  formErrors: newFormErrors,
                },
              };
            }

            const translatedMessage =
              typeof shape.message === "string"
                ? translateValidationKey(messages, shape.message)
                : shape.message;

            return {
              ...shape,
              message: translatedMessage,
              data: translatedData,
            };
          },
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
            // so CI failures have diagnosable context. Safe to keep: does not
            // expose anything a caller couldn't already infer from the 4xx.
            app.log.warn(
              {
                path,
                code: error.code,
                message: error.message,
                cause:
                  error.cause instanceof Error
                    ? error.cause.message
                    : undefined,
                input,
              },
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
