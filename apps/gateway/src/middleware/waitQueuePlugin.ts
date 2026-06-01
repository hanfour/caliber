// Wait-queue admission control (design §4.3). Sits after `apiKeyAuthPlugin`
// so it can read `req.apiKey.userId`, and before the proxy routes. A user may
// have at most `GATEWAY_MAX_WAIT` in-flight requests; the next is shed with
// `429 wait_queue_full`. The entry is removed when the request completes
// (onResponse); the Lua script's 300s EXPIRE is the safety net if that hook
// is ever missed (e.g. dropped connection). Fail-open per design §4.7 — a Redis
// error admits the request rather than dropping all traffic.
//
// Public paths (/health, /metrics, /oauth/callback) leave `req.apiKey` null and
// are skipped, same convention as `rateLimitPlugin`.

import fp from "fastify-plugin";
import type { ServerEnv } from "@caliber/config";
import { enqueueWait, dequeueWait } from "../redis/waitQueue.js";
import { keys } from "../redis/keys.js";

export interface WaitQueueOptions {
  env: ServerEnv;
}

declare module "fastify" {
  interface FastifyRequest {
    // Set once a request is admitted so onResponse knows to dequeue it.
    gwWaitEnqueued?: { userId: string; requestId: string };
  }
}

export const waitQueuePlugin = fp<WaitQueueOptions>(pluginBody, {
  name: "waitQueuePlugin",
  // Needs both `fastify.redis` and `req.apiKey` (set by apiKeyAuthPlugin).
  dependencies: ["apiKeyAuthPlugin"],
});

async function pluginBody(
  fastify: import("fastify").FastifyInstance,
  opts: WaitQueueOptions,
): Promise<void> {
  const maxWait = opts.env.GATEWAY_MAX_WAIT;

  fastify.addHook("preHandler", async (req, reply) => {
    if (maxWait === 0) return; // admission disabled
    if (!req.apiKey) return; // public path — nothing to gate on

    const userId = req.apiKey.userId;
    const requestId = req.id;

    let admitted: boolean;
    try {
      admitted = await enqueueWait(fastify.redis, userId, requestId, maxWait);
    } catch (err) {
      // Fail-open per design §4.7.
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "wait_queue_enqueue_failed",
      );
      return;
    }

    if (!admitted) {
      reply.code(429).send({ error: "wait_queue_full", maxWait });
      return reply;
    }

    req.gwWaitEnqueued = { userId, requestId };

    // Best-effort depth gauge (design §4.9). A single unlabeled gauge can't
    // represent every user's queue, so this is a per-request "last seen depth"
    // sample — non-zero whenever some user's queue is filling. Never fail the
    // request over a gauge read.
    try {
      const depth = await fastify.redis.zcard(keys.wait(userId));
      fastify.gwMetrics?.waitQueueDepth.set(depth);
    } catch {
      // ignore — metric only
    }
  });

  fastify.addHook("onResponse", async (req) => {
    const enq = req.gwWaitEnqueued;
    if (!enq) return;
    try {
      await dequeueWait(fastify.redis, enq.userId, enq.requestId);
    } catch {
      // Best-effort; the ZSET's 300s EXPIRE cleans up a leaked entry.
    }
  });
}
