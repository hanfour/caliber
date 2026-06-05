import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { groupContextPlugin } from "../../src/middleware/groupContext.js";

interface FixtureKey {
  id: string;
  orgId: string;
  userId: string;
  teamId: string | null;
  groupId: string | null;
  quotaUsd: string;
  quotaUsedUsd: string;
  routingPolicy: "pool" | "own" | "own_then_pool";
}

interface GroupRow {
  id: string;
  platform: string;
  rateMultiplier: string;
  isExclusive: boolean;
}

function makeMockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain["limit"] as ReturnType<typeof vi.fn>).mockReturnValue(
    Promise.resolve(rows),
  );
  return chain;
}

/** Stand-in for `dbPlugin` so groupContextPlugin's deps resolve. */
function fakeDbPlugin(mockDb: unknown) {
  return fp(
    async (fastify) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fastify.decorate("db", mockDb as any);
    },
    { name: "dbPlugin" },
  );
}

/** Fake apiKeyAuth plugin so groupContext has something to read. */
function fakeApiKeyAuth(apiKey: FixtureKey | null) {
  return fp(
    async (fastify) => {
      fastify.decorateRequest("apiKey", null);
      fastify.addHook("preHandler", async (req) => {
        // Mutating decorated request properties through `as never` keeps
        // the TS types simple — production middleware does the same.
        (req as unknown as { apiKey: FixtureKey | null }).apiKey = apiKey;
      });
    },
    { name: "apiKeyAuthPlugin", dependencies: ["dbPlugin"] },
  );
}

async function buildApp(opts: {
  apiKey: FixtureKey | null;
  groupRows: GroupRow[];
  /** Extra upstream route(s) to register so BYOK surface-platform
   *  resolution has a real route URL to map. */
  routeUrl?: string;
}) {
  const app = Fastify({ logger: false });
  const mockDb = makeMockDb(opts.groupRows);

  await app.register(fakeDbPlugin(mockDb));
  await app.register(fakeApiKeyAuth(opts.apiKey));
  await app.register(groupContextPlugin);

  const echo = async (req: import("fastify").FastifyRequest) => {
    const ctx = (req as unknown as { gwGroupContext: unknown }).gwGroupContext;
    return { ctx };
  };

  app.get("/echo", echo);
  if (opts.routeUrl) {
    app.post(opts.routeUrl, echo);
  }

  return { app, mockDb };
}

const BASE_KEY: FixtureKey = {
  id: "key-1",
  orgId: "org-1",
  userId: "user-1",
  teamId: null,
  groupId: "group-1",
  quotaUsd: "100",
  quotaUsedUsd: "0",
  routingPolicy: "pool",
};

describe("groupContext middleware", () => {
  it("attaches gwGroupContext when the group resolves", async () => {
    const { app } = await buildApp({
      apiKey: BASE_KEY,
      groupRows: [
        {
          id: "group-1",
          platform: "openai",
          rateMultiplier: "1.5",
          isExclusive: false,
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "group-1",
        platform: "openai",
        rateMultiplier: 1.5,
        isExclusive: false,
        isLegacy: false,
      },
    });
  });

  it("synthesises legacy ctx when apiKey.groupId is null (no DB query)", async () => {
    const { app, mockDb } = await buildApp({
      apiKey: { ...BASE_KEY, groupId: null },
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "legacy:org-1",
        platform: "anthropic",
        isLegacy: true,
      },
    });
    // resolveGroupContext short-circuits on null groupId — no DB hit.
    expect(
      (mockDb["select"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("returns 403 group_not_found_or_disabled when the group is missing", async () => {
    const { app } = await buildApp({
      apiKey: BASE_KEY,
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "group_not_found_or_disabled" });
  });

  it("skips resolution for unauthenticated paths (req.apiKey == null)", async () => {
    const { app, mockDb } = await buildApp({
      apiKey: null,
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ctx: null });
    expect(
      (mockDb["select"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("non-pool key (own, groupId=null) → groupless surface-derived ctx, no legacy synth, no DB hit", async () => {
    const { app, mockDb } = await buildApp({
      apiKey: { ...BASE_KEY, groupId: null, routingPolicy: "own" },
      groupRows: [],
      routeUrl: "/v1/chat/completions",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: null,
        platform: "openai",
        rateMultiplier: 1.0,
        isExclusive: false,
        isLegacy: false,
        isByok: true,
        policy: "own",
      },
    });
    // No real group → no DB lookup.
    expect(
      (mockDb["select"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("pool key (groupId=null) on an upstream route → UNCHANGED legacy synth, isByok=false", async () => {
    const { app } = await buildApp({
      apiKey: { ...BASE_KEY, groupId: null, routingPolicy: "pool" },
      groupRows: [],
      routeUrl: "/v1/chat/completions",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "legacy:org-1",
        platform: "anthropic",
        isLegacy: true,
        isByok: false,
        policy: "pool",
      },
    });
  });

  it("pool key with a real group still resolves the group's platform, isByok=false", async () => {
    const { app } = await buildApp({
      apiKey: { ...BASE_KEY, routingPolicy: "pool" },
      groupRows: [
        {
          id: "group-1",
          platform: "gemini",
          rateMultiplier: "1.0",
          isExclusive: false,
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "group-1",
        platform: "gemini",
        isLegacy: false,
        isByok: false,
        policy: "pool",
      },
    });
  });
});
