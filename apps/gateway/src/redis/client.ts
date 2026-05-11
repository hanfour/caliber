import fp from "fastify-plugin";
import { Redis } from "ioredis";
import type { ServerEnv } from "@caliber/config";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export interface RedisPluginOptions {
  env: ServerEnv;
  /** Optional override for tests — inject ioredis-mock */
  client?: Redis;
}

export const redisPlugin = fp<RedisPluginOptions>(
  async (fastify, opts) => {
    if (!opts.client && !opts.env.REDIS_URL) {
      throw new Error("REDIS_URL required when gateway is enabled");
    }

    const url = opts.env.REDIS_URL!;
    const client: Redis =
      opts.client ??
      new Redis(url, {
        enableAutoPipelining: true,
        maxRetriesPerRequest: 3,
        keyPrefix: "aide:gw:",
      });

    client.on("reconnecting", (delayMs: number) => {
      fastify.log.warn({ delayMs }, "redis reconnecting");
    });

    client.on("error", (err: Error) => {
      fastify.log.warn({ err: err.message }, "redis error");
    });

    fastify.addHook("onClose", async () => {
      await client.quit().catch((err: Error) => {
        fastify.log.debug(
          { err: err.message },
          "redis quit failed (likely already closed)",
        );
      });
    });

    fastify.decorate("redis", client);
  },
  { name: "redisPlugin" },
);
