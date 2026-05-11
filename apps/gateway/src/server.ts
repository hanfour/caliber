import Fastify, { type FastifyInstance } from "fastify";
import { parseServerEnv, type ServerEnv } from "@caliber/config";
import { LOG_REDACT_PATHS } from "@caliber/gateway-core";
import type { Database } from "@caliber/db";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { metricsPlugin } from "./plugins/metrics.js";
import { schedulerPlugin } from "./plugins/scheduler.js";
import { dbPlugin } from "./plugins/db.js";
import { redisPlugin } from "./redis/client.js";
import { apiKeyAuthPlugin } from "./middleware/apiKeyAuth.js";
import { rateLimitPlugin } from "./middleware/rateLimitPlugin.js";
import { groupContextPlugin } from "./middleware/groupContext.js";
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

declare module "fastify" {
  interface FastifyInstance {
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
  await app.register(groupContextPlugin);
  await app.register(messagesRoutes, { env: opts.env });
  await app.register(chatCompletionsRoutes, { env: opts.env });
  await app.register(responsesRoutes, { env: opts.env });
  await app.register(codexResponsesRoutes, { env: opts.env });

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

  const worker = createEvaluatorWorker({
    connection: bullmqRedis,
    db: app.db,
    redis: workerRedis,
    masterKeyHex: credentialEncryptionKey,
    gatewayBaseUrl: env.GATEWAY_LOCAL_BASE_URL,
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

async function main() {
  const env = parseServerEnv(process.env);
  const app = await buildServer({ env });
  const port = env.GATEWAY_PORT;
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
