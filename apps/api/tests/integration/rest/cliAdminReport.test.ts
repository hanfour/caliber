import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliAdminReportRoutes } from "../../../src/rest/cliAdminReport.js";
import { defaultTestEnv, makeTestRedis } from "../../factories/index.js";

const redis = makeTestRedis();
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cliAdminReportRoutes(defaultTestEnv, redis));
  await app.ready();
});

afterAll(async () => app.close());
beforeEach(async () => redis.flushall());

const payload = {
  org: "onead",
  member: "dev@example.com",
  period_start: "2026-07-01T00:00:00.000Z",
  period_end: "2026-07-02T00:00:00.000Z",
};

describe("POST /v1/cli/admin/report-bundle authentication", () => {
  it("rejects requests without a browser-issued CLI token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects unknown or expired CLI tokens before reading report data", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      headers: { authorization: "Bearer cct_expired" },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "expired_access_token" });
  });

  it("is unavailable when resident telemetry is disabled", async () => {
    const disabled = Fastify({ logger: false });
    await disabled.register(
      cliAdminReportRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }, redis),
    );
    const response = await disabled.inject({
      method: "POST",
      url: "/v1/cli/admin/report-bundle",
      payload,
    });
    expect(response.statusCode).toBe(404);
    await disabled.close();
  });
});
