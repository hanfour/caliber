import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { hashApiKey } from "@caliber/gateway-core";
import { apiKeyAuthPlugin } from "../../src/middleware/apiKeyAuth.js";

const PEPPER = "a".repeat(64);
const RAW_KEY = "ak_testkey123456789";
const KEY_HASH = hashApiKey(PEPPER, RAW_KEY);

const BASE_FIXTURE = {
  apiKey: {
    id: "key-1",
    orgId: "org-1",
    userId: "user-1",
    teamId: null,
    keyHash: KEY_HASH,
    revokedAt: null,
    expiresAt: null,
    revealTokenHash: null,
    revealedAt: null,
    ipWhitelist: null,
    ipBlacklist: null,
    quotaUsd: "100.00000000",
    quotaUsedUsd: "0.00000000",
  },
  user: { id: "user-1", email: "u@example.com" },
  org: { id: "org-1", slug: "acme" },
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

/** Stand-in for `dbPlugin` so apiKeyAuthPlugin's `dependencies` resolve. */
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
    return { id: (req as never as { apiKey: { id: string } }).apiKey?.id };
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/metrics", async () => ({ status: "ok" }));

  return app;
}

describe("apiKeyAuth middleware", () => {
  it("1. valid key → 200 + context attached", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const mockDb = app.db as unknown as Record<string, unknown>;
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "key-1" });
    // Assert query shape: where called once, innerJoin called twice
    expect(
      (mockDb["where"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
    expect(
      (mockDb["innerJoin"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2);
    // Assert select projection includes apiKey, user, org keys
    const selectCalls = (mockDb["select"] as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(selectCalls).toHaveLength(1);
    const selectArg = selectCalls[0]?.[0] as Record<string, unknown>;
    expect(selectArg).toHaveProperty("apiKey");
    expect(selectArg).toHaveProperty("user");
    expect(selectArg).toHaveProperty("org");
    await app.close();
  });

  it("2. no auth header → 401 missing_api_key", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "missing_api_key" });
    await app.close();
  });

  it("3. hash mismatch (db returns []) → 401 key_invalid", async () => {
    const app = await buildTestApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: "Bearer ak_wrongkey000000000" },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_invalid" });
    await app.close();
  });

  it("4. revoked key → 401 key_revoked", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: { ...BASE_FIXTURE.apiKey, revokedAt: new Date() },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_revoked" });
    await app.close();
  });

  it("5. expired key → 401 key_expired", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: { ...BASE_FIXTURE.apiKey, expiresAt: new Date("2000-01-01") },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_expired" });
    await app.close();
  });

  it("6. admin-issued key with revealedAt=null → 401 key_not_yet_revealed", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        revealTokenHash: "some-hash",
        revealedAt: null,
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_not_yet_revealed" });
    await app.close();
  });

  it("7. IP not in whitelist → 403 ip_not_allowed", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        ipWhitelist: ["192.168.1.0/24"],
        ipBlacklist: null,
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ip_not_allowed" });
    await app.close();
  });

  it("8. IP in blacklist → 403 ip_not_allowed", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        ipWhitelist: null,
        ipBlacklist: ["10.0.0.0/8"],
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ip_not_allowed" });
    await app.close();
  });

  it("9. /health bypasses middleware (db not called)", async () => {
    // Build app with crashing db to verify health skips auth
    const app = Fastify({ logger: false });
    const crashingDb = {
      select: vi.fn().mockImplementation(() => {
        throw new Error("DB should not be called for /health");
      }),
    };
    await app.register(fakeDbPlugin(crashingDb));

    await app.register(apiKeyAuthPlugin, {
      env: { API_KEY_HASH_PEPPER: PEPPER } as never,
    });

    app.get("/health", async () => ({ status: "ok" }));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    expect(crashingDb.select).not.toHaveBeenCalled();
    await app.close();
  });

  it("10. /metrics on the public listener is gated by auth (returns 401 unauth)", async () => {
    // Audit 2026-05-20 finding #5: /metrics moved to a private listener
    // (plugins/metricsServer.ts) bound to METRICS_HOST:METRICS_PORT.
    // The public listener's /metrics now requires an API key — scrapers
    // without one see 401, which is the desired hardening.
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("11. x-api-key header → passes + context attached", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "x-api-key": RAW_KEY },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "key-1" });
    await app.close();
  });

  it("12. /health?probe=1 bypasses middleware (query-string bypass)", async () => {
    const app = Fastify({ logger: false });
    const crashingDb = {
      select: vi.fn().mockImplementation(() => {
        throw new Error("DB should not be called for /health?probe=1");
      }),
    };
    await app.register(fakeDbPlugin(crashingDb));

    await app.register(apiKeyAuthPlugin, {
      env: { API_KEY_HASH_PEPPER: PEPPER } as never,
    });

    app.get("/health", async () => ({ status: "ok" }));

    const res = await app.inject({ method: "GET", url: "/health?probe=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    expect(crashingDb.select).not.toHaveBeenCalled();
    await app.close();
  });

  it("13. soft-deleted org → 401 key_invalid (db returns [] when org.deletedAt set)", async () => {
    // When organizations.deletedAt IS NOT NULL, the isNull(organizations.deletedAt)
    // filter in the WHERE clause causes the DB to return no rows — same path as
    // any other invalid key, so no info leakage about whether the key existed.
    const app = await buildTestApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "key_invalid" });
    await app.close();
  });

  it("14. case-insensitive bearer → 200", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "key-1" });
    await app.close();
  });

  it("14. x-api-key with trailing newline → 200", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "x-api-key": `${RAW_KEY}\n` },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "key-1" });
    await app.close();
  });

  it("15. Authorization Bearer wins when both headers present", async () => {
    const app = await buildTestApp([BASE_FIXTURE]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}`, "x-api-key": "ak_wrong" },
      remoteAddress: "10.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "key-1" });
    await app.close();
  });

  it("16. IPv6 whitelist match → 200", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        ipWhitelist: ["2001:db8::/32"],
        ipBlacklist: null,
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "2001:db8::1",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("17. IPv6 whitelist miss → 403 ip_not_allowed", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        ipWhitelist: ["2001:db8::/32"],
        ipBlacklist: null,
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "2001:db9::1",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ip_not_allowed" });
    await app.close();
  });

  it("18. malformed CIDR is skipped, valid CIDR matches → 200", async () => {
    const row = {
      ...BASE_FIXTURE,
      apiKey: {
        ...BASE_FIXTURE.apiKey,
        ipWhitelist: ["not-a-cidr", "10.0.0.0/8"],
        ipBlacklist: null,
      },
    };
    const app = await buildTestApp([row]);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
