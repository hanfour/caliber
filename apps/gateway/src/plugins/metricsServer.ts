import Fastify, { type FastifyInstance } from "fastify";
import client from "prom-client";
import type { ServerEnv } from "@caliber/config";

// Private metrics listener: serves prom-client's default register on a
// separate Fastify instance bound to env.METRICS_HOST:METRICS_PORT
// (default 127.0.0.1:9464). The main gateway listener no longer exposes
// /metrics publicly — apiKeyAuthPlugin's PUBLIC_PATHS dropped /metrics so
// the public listener returns 401 for unauthenticated scrape attempts.
//
// Why a separate Fastify instead of an auth gate on the main listener:
// keeping the scrape surface on a bind-restricted port means a
// misconfigured firewall or reverse proxy cannot accidentally leak
// org/account labels embedded in metric series. The bind is the firewall.

export interface MetricsServerOptions {
  env: ServerEnv;
  /** Test injection: when provided, the server uses this logger. */
  logger?: boolean;
}

export async function buildMetricsServer(
  opts: MetricsServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", client.register.contentType);
    return client.register.metrics();
  });

  // Liveness probe for the scraper sidecar so a misconfigured port shows
  // up as a 200/404 rather than connection refused.
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

export async function startMetricsServer(
  env: ServerEnv,
): Promise<FastifyInstance> {
  const app = await buildMetricsServer({ env });
  await app.listen({ port: env.METRICS_PORT, host: env.METRICS_HOST });
  return app;
}
