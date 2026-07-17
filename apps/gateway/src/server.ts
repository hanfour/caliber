import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { parseServerEnv, type ServerEnv } from "@caliber/config";
import { LOG_REDACT_PATHS } from "@caliber/gateway-core";
import type { Database } from "@caliber/db";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { metricsPlugin } from "./plugins/metrics.js";
import { startMetricsServer } from "./plugins/metricsServer.js";
import { schedulerPlugin } from "./plugins/scheduler.js";
import { dbPlugin } from "./plugins/db.js";
import { redisPlugin } from "./redis/client.js";
import { apiKeyAuthPlugin } from "./middleware/apiKeyAuth.js";
import { rateLimitPlugin } from "./middleware/rateLimitPlugin.js";
import { waitQueuePlugin } from "./middleware/waitQueuePlugin.js";
import { idempotencyReleasePlugin } from "./middleware/idempotencyReleasePlugin.js";
import { groupContextPlugin } from "./middleware/groupContext.js";
import { gatewayErrorHandler } from "./middleware/errorHandler.js";
import { messagesRoutes } from "./routes/messages.js";
import { chatCompletionsRoutes } from "./routes/chatCompletions.js";
import { responsesRoutes } from "./routes/responses.js";
import { codexResponsesRoutes } from "./routes/codexResponses.js";
import {
  createUsageLogQueue,
  type UsageLogJobPayload,
} from "./workers/usageLogQueue.js";
import {
  createBodyCaptureQueue,
  type BodyCaptureJobPayload,
} from "./workers/bodyCaptureQueue.js";
import { createBodyCaptureWorker } from "./workers/bodyCaptureWorker.js";
import {
  createEvaluatorQueue,
  type EvaluatorJobPayload,
} from "./workers/evaluator/queue.js";
import { createEvaluatorWorker } from "./workers/evaluator/worker.js";
import {
  maybeSendBudgetAlert,
  type BudgetAlertEvent,
} from "./workers/evaluator/budgetAlertWebhook.js";
import { UsageLogWorker } from "./workers/usageLogWorker.js";
import { BillingAudit } from "./workers/billingAudit.js";
import {
  startBodyPurgeCron,
  type BodyPurgeCronHandle,
} from "./workers/bodyPurge.js";
import {
  startEvaluatorCron,
  type EvaluatorCronHandle,
} from "./workers/evaluator/cron.js";
import {
  startGdprDeleteCron,
  type GdprDeleteCronHandle,
} from "./workers/gdprDelete.js";
import {
  startGdprExpireCron,
  type GdprExpireCronHandle,
} from "./workers/gdprExpire.js";
import {
  startIdempotencyPurgeCron,
  type IdempotencyPurgeCronHandle,
} from "./workers/idempotencyPurge.js";
import { createGithubSyncQueue } from "./workers/githubSync/queue.js";
import { createGithubSyncWorker } from "./workers/githubSync/worker.js";
import { startGithubSyncInterval } from "./workers/githubSync/interval.js";
import { createGithubDeliveryQueue } from "./workers/githubDelivery/queue.js";
import { createGithubDeliveryWorker } from "./workers/githubDelivery/worker.js";
import { startGithubDeliveryCron } from "./workers/githubDelivery/weeklyCron.js";
import { ModelRegistry } from "./models/modelRegistry.js";
import { buildRefreshDeps } from "./models/registryWiring.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * The resolved server env. Decorated so runtime helpers that only receive
     * `app` (e.g. emitUsageLog) can read config knobs without threading them
     * through every call site.
     */
    env: ServerEnv;
    /**
     * BullMQ usage-log queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (BullMQ does not work with ioredis-mock,
     * so test paths skip queue/worker/audit instantiation entirely — see
     * `BuildOpts.redis` rationale in this file).
     *
     * Route handlers (Sub-task B/C) read this via `fastify.usageLogQueue` and
     * call `enqueueUsageLog(fastify.usageLogQueue, payload, { fallback: ... })`.
     */
    usageLogQueue?: Queue<UsageLogJobPayload>;
    /**
     * BullMQ body-capture queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (same test-mode escape hatch as
     * `usageLogQueue`). Route handlers check for presence before enqueueing;
     * undefined means test mode — silently skip.
     */
    bodyCaptureQueue?: Queue<BodyCaptureJobPayload>;
    /**
     * BullMQ evaluator queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (same test-mode escape hatch as other
     * queues). Cron handler subscribes to this queue to enqueue daily jobs.
     */
    evaluatorQueue?: Queue<EvaluatorJobPayload>;
    /**
     * Live model catalog registry (model-alias resolution). Always decorated;
     * its background refresh loop only runs when GATEWAY_ENABLE_MODEL_ALIAS is
     * set. With the flag off the registry serves static fallbacks for every
     * bucket, so consumers can read `app.modelRegistry` unconditionally.
     */
    modelRegistry: ModelRegistry;
  }
}

export interface BuildOpts {
  env: ServerEnv;
  /** Optional test injection — passed straight through to dbPlugin. */
  db?: Database;
  /**
   * Optional test injection — passed straight through to redisPlugin.
   *
   * IMPORTANT: when `redis` is provided, we infer "this is a test" and skip
   * BullMQ queue/worker/audit instantiation entirely. Reason: BullMQ's Lua
   * scripts do not work against `ioredis-mock`, and existing tests inject
   * `ioredis-mock` via this seam. Production paths (where this option is
   * undefined) get the full BullMQ wiring against a fresh real Redis
   * connection built from `env.REDIS_URL`. Tests that need real BullMQ
   * lifecycle coverage live in `*.integration.test.ts` and stand up real
   * containers — they leave `redis` undefined.
   */
  redis?: Redis;
}

// Parse a comma-separated GATEWAY_TRUSTED_PROXIES env value into a Fastify
// `trustProxy` argument. Empty → `false` (do not trust X-Forwarded-*),
// non-empty → list of CIDRs / IPs (Fastify trusts XFF only from these
// peers). Exported for the api server to reuse the same parser.
export function parseTrustedProxies(raw: string): false | string[] {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length === 0 ? false : list;
}

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const enabled = opts.env.ENABLE_GATEWAY;
  const app = Fastify({
    logger: {
      level: opts.env.LOG_LEVEL,
      // Phase 3 #4-a — pino redacts known credential / auth-header paths
      // before any structured-log entry is serialised. Free-form strings
      // (e.g. err.message) still need `safeErrorMessage()` at the call
      // site; this is the structured-field defence.
      redact: { paths: [...LOG_REDACT_PATHS], censor: "[REDACTED]" },
    },
    bodyLimit: opts.env.GATEWAY_MAX_BODY_BYTES,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Trust X-Forwarded-For only from configured proxy CIDRs. Without this
    // (or with the prior `false` default) Fastify uses the socket peer IP,
    // which is the reverse proxy itself — breaking per-key IP allow/deny
    // lists at apiKeyAuthPlugin:117. Operators behind any L7 proxy MUST
    // set GATEWAY_TRUSTED_PROXIES to their proxy's CIDR, otherwise IP
    // enforcement stays broken. Empty default means "no proxy" — safe
    // for direct-internet deploys.
    trustProxy: parseTrustedProxies(opts.env.GATEWAY_TRUSTED_PROXIES),
  });
  app.decorate("env", opts.env);
  // Global SAFETY NET for errors that escape per-route handling. Registered at
  // the root so every route/plugin (incl. /health and the disabled-gateway
  // path) inherits it. Routes that already send explicit `reply.code().send()`
  // responses are UNAFFECTED — this only fires for genuinely-uncaught throws
  // (e.g. the BYOK `platformForGatewayRoute` throw on an unmapped route, or a
  // route catch block's terminal `throw err`). See errorHandler.ts.
  app.setErrorHandler(gatewayErrorHandler);
  // Expose the gateway's own request id (genReqId UUID, the usage_logs key) so
  // internal callers can correlate their row — the evaluator loopback reads
  // `x-request-id` to look up the eval call's cost + upstream. Without this the
  // /v1/messages passthrough only forwarded the upstream's `request-id`, so the
  // evaluator saw no `x-request-id` and silently dropped every LLM report.
  // Non-hijacked responses only (streaming clients don't need it).
  app.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("x-request-id")) {
      reply.header("x-request-id", request.id);
    }
  });
  await app.register(metricsPlugin);
  app.get("/health", async () =>
    enabled ? { status: "ok" } : { status: "disabled" },
  );
  if (!enabled) {
    app.log.warn("ENABLE_GATEWAY=false, gateway serves /health only");
    return app;
  }
  await app.register(dbPlugin, { env: opts.env, db: opts.db });
  await app.register(redisPlugin, { env: opts.env, client: opts.redis });
  await app.register(schedulerPlugin);
  await app.register(apiKeyAuthPlugin, { env: opts.env });
  await app.register(rateLimitPlugin, { env: opts.env });
  await app.register(waitQueuePlugin, { env: opts.env });
  await app.register(idempotencyReleasePlugin);
  await app.register(groupContextPlugin);
  await app.register(messagesRoutes, { env: opts.env });
  await app.register(chatCompletionsRoutes, { env: opts.env });
  await app.register(responsesRoutes, { env: opts.env });
  await app.register(codexResponsesRoutes, { env: opts.env });

  // Model-alias registry. Decorated unconditionally so route handlers can read
  // `app.modelRegistry` without a flag check — with the alias feature off the
  // registry simply serves static fallbacks (and increments the fallback
  // metric) for every bucket. The background refresh loop below is what's
  // actually gated on GATEWAY_ENABLE_MODEL_ALIAS.
  // ModelRegistry reads only the two `GATEWAY_MODEL_REGISTRY_FALLBACK_*` string
  // knobs from its `env` (via staticFallbackCatalog). Source them from the
  // parsed `opts.env` so buildServer({ env }) callers (tests / embedded) can
  // override fallbacks; the full ServerEnv carries boolean fields and isn't
  // assignable to Record<string, string | undefined>, so project just the two
  // string knobs into a fresh object.
  const modelRegistry = new ModelRegistry({
    env: {
      GATEWAY_MODEL_REGISTRY_FALLBACK_ANTHROPIC:
        opts.env.GATEWAY_MODEL_REGISTRY_FALLBACK_ANTHROPIC,
      GATEWAY_MODEL_REGISTRY_FALLBACK_OPENAI:
        opts.env.GATEWAY_MODEL_REGISTRY_FALLBACK_OPENAI,
    },
    fallbackMetric: (platform, bucketType) =>
      app.gwMetrics.modelRegistryFallbackUsedTotal.inc({
        platform,
        bucket_type: bucketType,
      }),
    logger: app.log,
    now: () => Date.now(),
    // Bound per-bucket cache freshness to 2× the refresh cadence: a single
    // missed/empty refresh is tolerated (stale-while-revalidate), but a
    // sustained failure expires within ~2 cycles → the bucket degrades to the
    // static fallback rather than serving stale ids forever. Derived from the
    // existing refresh-interval knob (no new env knob).
    ttlMs: opts.env.GATEWAY_MODEL_REGISTRY_REFRESH_SEC * 2 * 1000,
  });
  app.decorate("modelRegistry", modelRegistry);

  // Background catalog refresh — gated on the feature flag AND on real (non
  // test-injected) Redis, mirroring the cron gates below. The loop never blocks
  // startup (refreshOnce is fire-and-forget) and never throws into the gateway:
  // refreshOnce itself guards bucket discovery (logs + skips the cycle on
  // failure) and the per-bucket RefreshDeps swallow/metric per-bucket fetch
  // failures, degrading to fallbacks — so the `void`-ed calls below can never
  // produce an unhandled rejection.
  if (opts.redis === undefined && opts.env.GATEWAY_ENABLE_MODEL_ALIAS && app.db) {
    const refreshDeps = buildRefreshDeps({
      db: app.db,
      env: opts.env,
      fetchMetric: (platform, bucketType, result) =>
        app.gwMetrics.modelRegistryFetchTotal.inc({
          platform,
          bucket_type: bucketType,
          result,
        }),
      logger: app.log,
    });
    // One refresh on boot — do NOT await, startup must not block on upstreams.
    void modelRegistry.refreshOnce(refreshDeps);
    const refreshTimer = setInterval(
      () => void modelRegistry.refreshOnce(refreshDeps),
      opts.env.GATEWAY_MODEL_REGISTRY_REFRESH_SEC * 1000,
    );
    // Unref so the interval never holds the process / test runner open.
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
    app.addHook("onClose", async () => {
      clearInterval(refreshTimer);
    });
  }

  // BullMQ wiring: skip when a test injected its own Redis (see BuildOpts docs).
  if (opts.redis === undefined) {
    await wireUsageLogPipeline(app, opts.env);

    // Evaluator subsystem (body capture, evaluator queue/worker, crons) is
    // gated on ENABLE_EVALUATOR — defense-in-depth (design §8.1).
    // API side gates via evaluatorProcedure; this is the server-startup gate.
    if (opts.env.ENABLE_EVALUATOR) {
      await wireBodyCapturePipeline(app, opts.env);
      await wireEvaluatorPipeline(app, opts.env);
    } else {
      app.log.info(
        "ENABLE_EVALUATOR=false — body capture, evaluator pipeline, and evaluator crons are disabled",
      );
    }

    // github-sync subsystem (PR1): queue + worker + 6h interval, gated on
    // ENABLE_GITHUB_DELIVERY (defense-in-depth, mirrors the evaluator gate
    // above). Unlike the evaluator, PR1 has no separate cron block — the
    // interval is wired inside wireGithubSyncPipeline itself.
    if (opts.env.ENABLE_GITHUB_DELIVERY) {
      await wireGithubSyncPipeline(app, opts.env);
    }
  } else {
    app.log.debug(
      "buildServer: opts.redis injected — skipping BullMQ queue/worker/audit (test mode)",
    );
  }

  // Crons: skip when a test injected its own Redis (same gate as BullMQ wiring
  // above — tests that need cron coverage call cron functions directly).
  if (opts.redis === undefined) {
    // Body retention purge cron — Plan 4B Task 3.6.
    // Runs every 4h, purges request_bodies where retention_until <= now().
    // Gated on ENABLE_EVALUATOR: no captured bodies exist when evaluator is off,
    // so gating simplifies reasoning and avoids a no-op cron running in production.
    if (opts.env.ENABLE_EVALUATOR) {
      let purgeCronHandle: BodyPurgeCronHandle | undefined;
      if (app.db) {
        purgeCronHandle = startBodyPurgeCron({
          db: app.db,
          metrics: {
            deletedTotal: app.gwMetrics.bodyPurgeDeletedTotal,
            durationSeconds: app.gwMetrics.bodyPurgeDurationSeconds,
            lagHours: app.gwMetrics.bodyPurgeLagHours,
          },
          logger: app.log,
        });
        app.addHook("onClose", async () => {
          purgeCronHandle?.stop();
        });
      }

      // Daily evaluator cron — Plan 4B Part 4, Task 4.3.
      // Runs every 24h at 00:05 UTC, enqueues daily evaluator jobs for all users
      // in orgs with contentCaptureEnabled=true.
      let evaluatorCronHandle: EvaluatorCronHandle | undefined;
      if (app.db && app.evaluatorQueue) {
        evaluatorCronHandle = startEvaluatorCron({
          db: app.db,
          queue: app.evaluatorQueue,
          logger: app.log,
          enableProjectEvaluation: opts.env.ENABLE_PROJECT_EVALUATION,
          maxProjectKeysPerUser: opts.env.EVALUATOR_MAX_PROJECT_KEYS_PER_USER,
        });
        app.addHook("onClose", async () => {
          evaluatorCronHandle?.stop();
        });
      }

      // GDPR delete cron — Plan 4B Part 10, Task 10.1.
      // Runs every 5 min, executes approved GDPR delete requests and writes audit logs.
      // Gated on ENABLE_EVALUATOR: no GDPR requests arrive when evaluator is off.
      let gdprDeleteCronHandle: GdprDeleteCronHandle | undefined;
      if (app.db) {
        gdprDeleteCronHandle = startGdprDeleteCron({
          db: app.db,
          metrics: {
            executedTotal: app.gwMetrics.gwGdprDeleteExecutedTotal,
            bodiesDeletedTotal: app.gwMetrics.gwGdprBodiesDeletedTotal,
            reportsDeletedTotal: app.gwMetrics.gwGdprReportsDeletedTotal,
            failuresTotal: app.gwMetrics.gwGdprFailuresTotal,
          },
          logger: app.log,
        });
        app.addHook("onClose", async () => {
          gdprDeleteCronHandle?.stop();
        });
      }

      // GDPR expire cron — Plan 4B Part 10, Task 10.3.
      // Runs every 24h, auto-rejects pending GDPR requests older than 30 days.
      // Gated on ENABLE_EVALUATOR: no pending requests exist when evaluator is off.
      let gdprExpireCronHandle: GdprExpireCronHandle | undefined;
      if (app.db) {
        gdprExpireCronHandle = startGdprExpireCron({
          db: app.db,
          metrics: {
            autoRejectedTotal: app.gwMetrics.gwGdprAutoRejectedTotal,
          },
          logger: app.log,
        });
        app.addHook("onClose", async () => {
          gdprExpireCronHandle?.stop();
        });
      }
    }

    // Idempotency-record retention purge — Plan 4A §4.5. Gateway data written
    // regardless of the evaluator, so gate on the record TTL knob, NOT
    // ENABLE_EVALUATOR (which guards captured bodies).
    if (opts.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0 && app.db) {
      const idemPurgeHandle = startIdempotencyPurgeCron({
        db: app.db,
        metrics: { purgedTotal: app.gwMetrics.idempotencyRecordsPurgedTotal },
        logger: app.log,
      });
      app.addHook("onClose", async () => {
        idemPurgeHandle.stop();
      });
    }
  }

  return app;
}

/**
 * Build the dedicated BullMQ Redis connection + Queue + Worker + BillingAudit
 * and wire onClose teardown. Extracted so the test-injection escape hatch in
 * `buildServer` reads cleanly.
 *
 * Rationale for a separate Redis connection (vs reusing `fastify.redis`):
 * `redisPlugin` decorates `fastify.redis` with `keyPrefix: "caliber:gw:"`. BullMQ
 * computes Redis keys inside Lua scripts using its own `prefix` option and
 * does not see ioredis's transparent key prefixing — passing the prefixed
 * client breaks Lua atomicity (see usageLogQueue.ts module header). We build
 * a fresh `Redis` from `env.REDIS_URL` with `maxRetriesPerRequest: null`
 * (BullMQ requirement for blocking commands) and `enableAutoPipelining: true`
 * (matches the gateway's prefixed client tuning).
 */
async function wireUsageLogPipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    // parseServerEnv enforces this when ENABLE_GATEWAY=true, but guard
    // defensively so a future env-shape change surfaces a clear error here.
    throw new Error(
      "REDIS_URL required to wire BullMQ usage-log pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    // Required by BullMQ for blocking commands; see https://docs.bullmq.io/
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "bullmq redis error");
  });

  const queue = createUsageLogQueue({ connection: bullmqRedis });

  const worker = new UsageLogWorker(app.db, {
    logger: app.log,
    connection: bullmqRedis,
    queue,
    metrics: {
      queueDepth: app.gwMetrics.queueDepth,
      queueDlqCount: app.gwMetrics.queueDlqCount,
    },
  });
  worker.start();

  const audit = new BillingAudit(app.db, {
    logger: app.log,
    metrics: {
      billingDriftTotal: app.gwMetrics.billingDriftTotal,
      billingMonotonicityViolationTotal:
        app.gwMetrics.billingMonotonicityViolationTotal,
    },
  });
  audit.start();

  app.decorate("usageLogQueue", queue);

  // Teardown order matters:
  //   1. audit.stop()       — clear the timer so no new tick fires mid-shutdown
  //   2. worker.stop()      — drain in-flight batch + close BullMQ Worker
  //                            (waits for processor promises to settle)
  //   3. queue.close()      — close BullMQ Queue (releases its scheduler/etc.)
  //   4. bullmqRedis.quit() — close the dedicated ioredis connection last so
  //                            BullMQ's own close() above can still issue Redis
  //                            commands during shutdown
  //
  // The try/catch wrappers below catch thrown errors only — a step that hangs
  // (e.g. worker.stop() blocked on a wedged batch) will still stall shutdown
  // because its `await` never settles. For hard-deadline shutdown we'd need
  // Promise.race with a timeout; not added here because Fastify's close() has
  // a server-level grace and a hung BullMQ Worker indicates a deeper bug.
  app.addHook("onClose", async () => {
    audit.stop();
    try {
      await worker.stop();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log worker stop failed",
      );
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log queue close failed",
      );
    }
    // Required: BullMQ treats the passed-in ioredis instance as shared and
    // skips quit() inside Worker.close() / Queue.close(). Without this line
    // the TCP connection leaks until process exit.
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

/**
 * Build the dedicated BullMQ Redis connection + Queue for body capture and
 * wire onClose teardown. The worker is managed externally (bodyCaptureWorker.ts)
 * and not started here — only the queue is decorated so route handlers can enqueue.
 *
 * Uses a separate Redis connection from usageLogPipeline (same rationale: BullMQ
 * Lua scripts cannot share the prefixed `fastify.redis` client).
 */
async function wireBodyCapturePipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL required to wire BullMQ body-capture pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "body capture bullmq redis error");
  });

  const queue = createBodyCaptureQueue({ connection: bullmqRedis });

  app.decorate("bodyCaptureQueue", queue);

  // Spawn the worker that drains the queue into request_bodies. Without
  // this, jobs accumulate in redis indefinitely while content_capture
  // *appears* enabled — the prior comment claimed the worker was
  // "managed externally" but no caller ever started it.
  // CREDENTIAL_ENCRYPTION_KEY is already required by parseServerEnv when
  // ENABLE_GATEWAY=true, so the non-null assertion is safe here.
  if (!app.db) {
    throw new Error(
      "app.db must be decorated before wireBodyCapturePipeline runs",
    );
  }
  const worker = createBodyCaptureWorker({
    connection: bullmqRedis,
    db: app.db,
    masterKeyHex: env.CREDENTIAL_ENCRYPTION_KEY!,
  });
  worker.on("failed", (job, err) => {
    app.log.warn(
      {
        jobId: job?.id,
        attempt: job?.attemptsMade,
        err: err.message,
      },
      "body capture job failed",
    );
  });

  app.addHook("onClose", async () => {
    try {
      await worker.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "body capture worker close failed",
      );
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "body capture queue close failed",
      );
    }
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "body capture bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

/**
 * Build the `onBudgetEvent` webhook-alert sink shared by the evaluator and
 * github-delivery pipelines (Task 5, budget metrics/webhook parity).
 *
 * The two pipelines are gated independently (`ENABLE_EVALUATOR` vs.
 * `ENABLE_GITHUB_DELIVERY`) and each owns its own dedicated Redis
 * connection (BullMQ Lua scripts can't share the prefixed `fastify.redis`
 * client — see the pipeline doc comments below), so a single closure
 * *instance* can't be shared across both without coupling one pipeline's
 * wiring to the other's gate. Instead this factory is called once per
 * pipeline with that pipeline's own redis client; `maybeSendBudgetAlert`'s
 * dedup keys live in Redis, so either connection produces identical dedup
 * behavior — the two resulting closures are behaviorally interchangeable.
 */
function buildOnBudgetEventSink(
  app: FastifyInstance,
  redis: Redis,
  alertWebhookUrl: string | undefined,
): ((e: BudgetAlertEvent) => void) | undefined {
  if (!alertWebhookUrl) return undefined;
  return (e: BudgetAlertEvent) => {
    void maybeSendBudgetAlert(
      {
        redis,
        fetch: globalThis.fetch,
        webhookUrl: alertWebhookUrl,
        logger: app.log,
        now: () => new Date(),
      },
      e,
    );
  };
}

/**
 * Build the dedicated BullMQ Redis connection + Queue for evaluator cron
 * and wire onClose teardown. The cron is started in buildServer and manages
 * itself via the EvaluatorCronHandle; only the queue is decorated here so the
 * cron can enqueue jobs.
 *
 * Uses a separate Redis connection from other pipelines (same rationale: BullMQ
 * Lua scripts cannot share the prefixed `fastify.redis` client).
 */
async function wireEvaluatorPipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL required to wire BullMQ evaluator pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const credentialEncryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!credentialEncryptionKey) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY required to wire evaluator pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "evaluator bullmq redis error");
  });

  // A separate un-prefixed Redis connection for the worker's LLM eval calls
  // (same rationale as bullmqRedis — must not share the prefixed fastify.redis).
  const workerRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });

  workerRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "evaluator worker redis error");
  });

  const queue = createEvaluatorQueue({ connection: bullmqRedis });

  // Active webhook alerting for org budget warn/exceeded (Plan P4). Only wired
  // when GATEWAY_ALERT_WEBHOOK_URL is set; the sink is fire-and-forget (voided).
  const onBudgetEvent = buildOnBudgetEventSink(
    app,
    workerRedis,
    env.GATEWAY_ALERT_WEBHOOK_URL,
  );

  // PR7: wire app.gwMetrics so the evaluator worker emits Prometheus counters
  // (gwEvalLlmCalledTotal{grain,result}, gwEvalLlmCostUsd{grain}, etc.).
  // Before this line the worker ran with metrics:undefined — counters never
  // incremented in production. EvaluationMetrics is structurally compatible
  // with GatewayMetrics (all fields are optional, GatewayMetrics provides them
  // all), so no cast is required.
  const worker = createEvaluatorWorker({
    connection: bullmqRedis,
    db: app.db,
    redis: workerRedis,
    masterKeyHex: credentialEncryptionKey,
    gatewayBaseUrl: env.GATEWAY_LOCAL_BASE_URL,
    onBudgetEvent,
    metrics: app.gwMetrics,
  });

  app.decorate("evaluatorQueue", queue);

  app.addHook("onClose", async () => {
    try {
      await worker.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "evaluator worker close failed",
      );
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "evaluator queue close failed",
      );
    }
    await workerRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "evaluator worker redis quit failed (likely already closed)",
      );
    });
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "evaluator bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

/**
 * Build the dedicated BullMQ Redis connection + Queue + Worker + 6h sync
 * interval for the github-sync subsystem (PR1) and wire onClose teardown.
 * Bundled into a single function (unlike the evaluator's split
 * pipeline/cron wiring) because PR1 has no separate body-capture step —
 * the queue, worker, and interval are all this subsystem needs.
 *
 * Uses a separate Redis connection from other pipelines (same rationale as
 * wireEvaluatorPipeline: BullMQ Lua scripts cannot share the prefixed
 * `fastify.redis` client).
 */
async function wireGithubSyncPipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  if (!env.REDIS_URL) {
    throw new Error("ENABLE_GITHUB_DELIVERY requires REDIS_URL");
  }
  const masterKeyHex = env.CREDENTIAL_ENCRYPTION_KEY;
  if (!masterKeyHex) {
    throw new Error("ENABLE_GITHUB_DELIVERY requires CREDENTIAL_ENCRYPTION_KEY");
  }

  const githubRedis = new Redis(env.REDIS_URL, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });
  githubRedis.on("error", (err) => {
    app.log.warn({ err }, "github-sync redis error");
  });

  const queue = createGithubSyncQueue({ connection: githubRedis });
  const worker = createGithubSyncWorker({
    connection: githubRedis,
    db: app.db,
    masterKeyHex,
  });
  const cronHandle = startGithubSyncInterval({
    db: app.db,
    queue,
    logger: app.log,
  });

  // github-delivery (PR2): shares this pipeline's dedicated redis
  // connection + masterKeyHex; wired after the sync queue/worker/interval
  // so sync stays the primary subsystem this function documents.
  //
  // Task 5 (budget metrics/webhook parity): this pipeline is gated
  // independently of wireEvaluatorPipeline (ENABLE_GITHUB_DELIVERY vs.
  // ENABLE_EVALUATOR), so it can't reuse that pipeline's onBudgetEvent
  // closure — it may run without the evaluator pipeline ever having wired
  // one. Build an equivalent sink over this pipeline's own githubRedis
  // connection instead (see buildOnBudgetEventSink's doc comment).
  const onBudgetEvent = buildOnBudgetEventSink(
    app,
    githubRedis,
    env.GATEWAY_ALERT_WEBHOOK_URL,
  );

  const deliveryQueue = createGithubDeliveryQueue({ connection: githubRedis });
  const deliveryWorker = createGithubDeliveryWorker({
    connection: githubRedis,
    db: app.db,
    masterKeyHex,
    redis: githubRedis,
    gatewayBaseUrl: env.GATEWAY_LOCAL_BASE_URL,
    logger: app.log,
    onBudgetEvent,
    metrics: app.gwMetrics,
  });
  const deliveryCronHandle = startGithubDeliveryCron({
    db: app.db,
    queue: deliveryQueue,
    logger: app.log,
  });

  app.addHook("onClose", async () => {
    cronHandle.stop();
    deliveryCronHandle.stop();
    try {
      await worker.close();
    } catch (err) {
      app.log.warn({ err }, "github-sync worker close failed");
    }
    try {
      await deliveryWorker.close();
    } catch (err) {
      app.log.warn({ err }, "github-delivery worker close failed");
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.debug({ err }, "github-sync queue close failed");
    }
    try {
      await deliveryQueue.close();
    } catch (err) {
      app.log.debug({ err }, "github-delivery queue close failed");
    }
    try {
      await githubRedis.quit();
    } catch (err) {
      app.log.debug({ err }, "github-sync redis quit failed");
    }
  });
}

async function main() {
  const env = parseServerEnv(process.env);
  const app = await buildServer({ env });

  // Private metrics listener — bound to METRICS_HOST:METRICS_PORT
  // (default 127.0.0.1:9464) so scrapers must share a network namespace.
  // The public listener's /metrics now requires API-key auth and is not
  // intended for prometheus scraping. See plugins/metricsServer.ts.
  //
  // Started + onClose registered BEFORE the public listen() — Fastify
  // rejects addHook("onClose", ...) once the instance has transitioned
  // to listening state, so this ordering is load-bearing.
  const metricsApp = await startMetricsServer(env);
  app.addHook("onClose", async () => {
    await metricsApp.close();
  });

  const port = env.GATEWAY_PORT;
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
