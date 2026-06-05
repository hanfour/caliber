import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the Task 11 BYOK isolation gap: the
// `/v1/responses/compact` handler was the ONE of 13 `runFailover` call sites
// that omitted `routingPolicy` + `userId`, so a non-pool ("own") BYOK key
// silently routed as `pool` (own→pool isolation downgrade). The other 12 sites
// thread `<ctx>.policy` / `req.apiKey.userId`. This test drives the compact
// handler with an "own" group context and asserts the `runFailover` input it
// constructs carries `routingPolicy: "own"` and the caller's `userId` — so a
// future regression that drops those fields is caught at the route boundary,
// not silently in production. (The fields stay optional on `RunFailoverInput`
// for the loop's own mechanics tests; see the contract note there.)

// --- module mocks: isolate the handler from the failover loop, idempotency,
//     and the upstream call so we only assert the runFailover INPUT shape. ---
const runFailoverMock = vi.fn();
vi.mock("../../src/runtime/failoverLoop.js", () => ({
  runFailover: (input: unknown) => runFailoverMock(input),
  // Re-export the error classes the handler `instanceof`-checks. Real classes
  // so the catch blocks behave; the happy path here never throws them.
  AllUpstreamsFailed: class AllUpstreamsFailed extends Error {},
  FatalUpstreamError: class FatalUpstreamError extends Error {},
}));

vi.mock("../../src/routes/idempotencyEntry.js", () => ({
  // No X-Request-Id → idempotency is a no-op (handled:false, idemKey:null).
  checkRequestIdempotency: vi.fn(async () => ({ handled: false, idemKey: null })),
}));

vi.mock("../../src/runtime/idempotencyCache.js", () => ({
  storeIdempotent: vi.fn(),
}));

import { makeResponsesCompactRouteHandler } from "../../src/routes/responses.js";

function makeReplyStub() {
  const calls: { code?: number; sent?: unknown } = {};
  const reply: Record<string, unknown> = {};
  reply.code = (c: number) => {
    calls.code = c;
    return reply;
  };
  reply.header = () => reply;
  reply.send = (body: unknown) => {
    calls.sent = body;
    return reply;
  };
  return { reply, calls };
}

function makeReqStub(overrides: Record<string, unknown> = {}) {
  const closeListeners: Array<() => void> = [];
  return {
    id: "test-req-id",
    headers: {},
    body: { model: "gpt-5", input: "summarise" },
    apiKey: {
      id: "key-1",
      orgId: "org-1",
      teamId: null,
      groupId: "grp-1",
      userId: "user-byok-1",
    },
    gwUser: { id: "user-byok-1" },
    gwOrg: { id: "org-1" },
    // BYOK: the resolved group context routes to the caller's OWN upstreams.
    gwGroupContext: { platform: "openai", policy: "own" },
    raw: {
      once: (_evt: string, cb: () => void) => closeListeners.push(cb),
      removeListener: () => {},
    },
    ...overrides,
  };
}

const appStub = {
  db: {},
  redis: {},
  gwScheduler: {},
} as never;

const optsStub = {
  env: {
    GATEWAY_MAX_ACCOUNT_SWITCHES: 3,
    UPSTREAM_OPENAI_BASE_URL: "http://upstream.test",
    GATEWAY_IDEMPOTENCY_TTL_SEC: 60,
  },
} as never;

describe("/v1/responses/compact — BYOK routing policy forwarding (Task 11 gap)", () => {
  beforeEach(() => {
    runFailoverMock.mockReset();
    // Return a minimal upstream so the handler's happy path completes.
    runFailoverMock.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}'),
    });
  });

  it("forwards routingPolicy:'own' + userId to runFailover for an own-policy key", async () => {
    const handler = makeResponsesCompactRouteHandler(appStub, optsStub);
    const req = makeReqStub();
    const { reply } = makeReplyStub();

    await handler(req as never, reply as never);

    expect(runFailoverMock).toHaveBeenCalledTimes(1);
    const input = runFailoverMock.mock.calls[0]![0] as Record<string, unknown>;
    // The core regression assertions — these are exactly the two fields that
    // were missing at responses.ts:534.
    expect(input.routingPolicy).toBe("own");
    expect(input.userId).toBe("user-byok-1");
    // Sanity: the other scope fields are still threaded as before.
    expect(input.orgId).toBe("org-1");
    expect(input.groupId).toBe("grp-1");
    expect(input.platform).toBe("openai");
  });

  it("forwards routingPolicy:'pool' verbatim for a pool key (no silent coercion)", async () => {
    const handler = makeResponsesCompactRouteHandler(appStub, optsStub);
    const req = makeReqStub({
      gwGroupContext: { platform: "openai", policy: "pool" },
      apiKey: {
        id: "key-2",
        orgId: "org-1",
        teamId: null,
        groupId: "grp-1",
        userId: "user-pool-1",
      },
    });
    const { reply } = makeReplyStub();

    await handler(req as never, reply as never);

    const input = runFailoverMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.routingPolicy).toBe("pool");
    expect(input.userId).toBe("user-pool-1");
  });
});
