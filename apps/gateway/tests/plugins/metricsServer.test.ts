import { describe, it, expect, afterEach } from "vitest";
import client from "prom-client";
import type { FastifyInstance } from "fastify";
import type { ServerEnv } from "@caliber/config";
import { buildMetricsServer } from "../../src/plugins/metricsServer.js";

// Minimal env stub — buildMetricsServer only reads METRICS_HOST /
// METRICS_PORT via startMetricsServer, not buildMetricsServer itself,
// so this is enough for the route assertions.
const env = {
  METRICS_HOST: "127.0.0.1",
  METRICS_PORT: 0, // not used by buildMetricsServer; startMetricsServer would
} as ServerEnv;

describe("metricsServer (private listener)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
  });

  it("serves /metrics with prom-client content-type and at least one metric", async () => {
    // Seed the global default registry with a deterministic counter so the
    // response is non-empty regardless of test ordering.
    const probe = new client.Counter({
      name: "test_metrics_server_probe_total",
      help: "test-only counter to assert the listener wires prom-client",
    });
    probe.inc();

    const app = await buildMetricsServer({ env });
    apps.push(app);

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(client.register.contentType);
    expect(res.body).toContain("test_metrics_server_probe_total");
  });

  it("/health returns 200 for liveness probes", async () => {
    const app = await buildMetricsServer({ env });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("uses the global default register, so metrics collected by metricsPlugin appear here", async () => {
    // Anything registered on prom-client's default register (which is what
    // fastify-metrics + metricsPlugin write to) is reflected here. Spot-check
    // with a fresh counter to keep the test stable across registration order.
    const tag = `test_shared_register_${Date.now()}_total`;
    const c = new client.Counter({ name: tag, help: "shared register probe" });
    c.inc(7);

    const app = await buildMetricsServer({ env });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain(tag);
    expect(res.body).toMatch(new RegExp(`${tag} 7`));
  });
});
