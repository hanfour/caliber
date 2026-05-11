import fp from "fastify-plugin";
import { createDb, type Database } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export interface DbPluginOptions {
  env: ServerEnv;
  /** Optional injection seam for tests — pass a mock to skip pool creation. */
  db?: Database;
}

export const dbPlugin = fp<DbPluginOptions>(
  async (fastify, opts) => {
    if (opts.db) {
      fastify.decorate("db", opts.db);
      return;
    }
    const { db, pool } = createDb(opts.env.DATABASE_URL);
    fastify.addHook("onClose", async () => {
      await pool.end();
    });
    fastify.decorate("db", db);
  },
  { name: "dbPlugin" },
);
