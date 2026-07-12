import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliAdminPoolRoutes } from "../../../src/rest/cliAdminPool.js";
import { defaultTestEnv, makeTestRedis } from "../../factories/index.js";

const redis = makeTestRedis();
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cliAdminPoolRoutes(defaultTestEnv, redis));
  await app.ready();
});
afterAll(async () => app.close());
beforeEach(async () => redis.flushall());

describe("CLI admin pool OAuth feature gates", () => {
  it("requires a browser-issued CLI token when OAuth is enabled", async () => {
    const enabled = Fastify({ logger: false });
    await enabled.register(
      cliAdminPoolRoutes({ ...defaultTestEnv, ENABLE_ANTHROPIC_OAUTH: true }, redis),
    );
    const response = await enabled.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/start",
      payload: { org: "onead" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    await enabled.close();
  });

  it("does not expose the flow when Anthropic OAuth is disabled", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/start",
      payload: { org: "onead" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "anthropic_oauth_disabled" });
  });

  it("is unavailable when the gateway is disabled", async () => {
    const disabled = Fastify({ logger: false });
    await disabled.register(
      cliAdminPoolRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }, redis),
    );
    const response = await disabled.inject({
      method: "POST",
      url: "/v1/cli/admin/pool/oauth/start",
      payload: { org: "onead" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    await disabled.close();
  });
});
