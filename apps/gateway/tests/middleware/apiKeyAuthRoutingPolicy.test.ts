import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { hashApiKey } from "@caliber/gateway-core";
import { apiKeyAuthPlugin } from "../../src/middleware/apiKeyAuth.js";

const PEPPER = "a".repeat(64);
const RAW_KEY = "ak_routingpolicytest";
const KEY_HASH = hashApiKey(PEPPER, RAW_KEY);

const BASE_FIXTURE = {
  apiKey: {
    id: "key-rp-1",
    orgId: "org-1",
    userId: "user-1",
    teamId: null,
    groupId: null,
    keyHash: KEY_HASH,
    revokedAt: null,
    expiresAt: null,
    revealTokenHash: null,
    revealedAt: null,
    ipWhitelist: null,
    ipBlacklist: null,
    quotaUsd: "100.00000000",
    quotaUsedUsd: "0.00000000",
    routingPolicy: "pool",
  },
  user: { id: "user-1", email: "u@example.com" },
  org: {
    id: "org-1",
    slug: "acme",
    contentCaptureEnabled: false,
    retentionDaysOverride: null,
  },
};

function makeMockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "innerJoin", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain["limit"] as ReturnType<typeof vi.fn>).mockReturnValue(
    Promise.resolve(rows),
  );
  return chain;
}

function fakeDbPlugin(mockDb: unknown) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("db", mockDb as any);
    },
    { name: "dbPlugin" },
  );
}

async function buildTestApp(rows: unknown[]) {
  const app = Fastify({ logger: false });
  const mockDb = makeMockDb(rows);
  await app.register(fakeDbPlugin(mockDb));

  await app.register(apiKeyAuthPlugin, {
    env: { API_KEY_HASH_PEPPER: PEPPER } as never,
  });

  app.get("/echo", async (req) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = (req as any).apiKey as {
      id: string;
      routingPolicy: string;
    } | null;
    return { id: key?.id ?? null, routingPolicy: key?.routingPolicy ?? null };
  });

  return app;
}

describe("apiKeyAuth – routingPolicy propagation", () => {
  it("1. key with routingPolicy='own' → req.apiKey.routingPolicy equals 'own'", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: { ...BASE_FIXTURE.apiKey, routingPolicy: "own" },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ routingPolicy: "own" });
    await app.close();
  });

  it("2. key with default routingPolicy ('pool') → req.apiKey.routingPolicy equals 'pool'", async () => {
    // BASE_FIXTURE has routingPolicy: 'pool' (the DB default)
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ routingPolicy: "pool" });
    await app.close();
  });

  it("3. key with routingPolicy='own_then_pool' → req.apiKey.routingPolicy equals 'own_then_pool'", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: { ...BASE_FIXTURE.apiKey, routingPolicy: "own_then_pool" },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ routingPolicy: "own_then_pool" });
    await app.close();
  });
});
