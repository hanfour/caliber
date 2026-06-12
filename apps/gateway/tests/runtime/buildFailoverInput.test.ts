// Unit test for the route-facing `buildFailoverInput` builder. Guards the
// BYOK isolation contract at the source: the builder must lift
// `routingPolicy` + `userId` (and the rest of the scope) off the request so a
// route callsite cannot omit them. The compile-time half of the guarantee
// (omission is a TYPE error) is enforced by the `Omit<...>` per-call type +
// the REQUIRED fields on `RunFailoverInput`; this covers the runtime read.

import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { buildFailoverInput } from "../../src/runtime/buildFailoverInput.js";
import type { SelectedAccount } from "../../src/runtime/selectAccount.js";

const db = { tag: "db" } as never;
const attempt = async (_a: SelectedAccount) => "ok";

function makeReq(
  apiKey: Record<string, unknown> | null,
  gwGroupContext: Record<string, unknown> | null,
  server?: Record<string, unknown>,
): FastifyRequest {
  return { apiKey, gwGroupContext, server } as unknown as FastifyRequest;
}

describe("buildFailoverInput", () => {
  it("lifts routingPolicy + userId + scope from req.apiKey/req.gwGroupContext", () => {
    const req = makeReq(
      {
        orgId: "org-1",
        teamId: "team-9",
        groupId: "grp-7",
        userId: "user-byok-1",
      },
      { policy: "own", platform: "openai" },
    );

    const input = buildFailoverInput(req, db, {
      maxSwitches: 3,
      attempt,
    });

    expect(input.routingPolicy).toBe("own");
    expect(input.userId).toBe("user-byok-1");
    expect(input.platform).toBe("openai");
    expect(input.orgId).toBe("org-1");
    expect(input.teamId).toBe("team-9");
    expect(input.groupId).toBe("grp-7");
    expect(input.db).toBe(db);
    // per-call fields pass through verbatim
    expect(input.maxSwitches).toBe(3);
    expect(input.attempt).toBe(attempt);
  });

  it("forwards a pool key verbatim (no silent coercion) and null groupId", () => {
    const req = makeReq(
      { orgId: "org-2", teamId: null, groupId: null, userId: "user-pool-1" },
      { policy: "pool", platform: "anthropic" },
    );

    const input = buildFailoverInput(req, db, { maxSwitches: 1, attempt });

    expect(input.routingPolicy).toBe("pool");
    expect(input.userId).toBe("user-pool-1");
    expect(input.groupId).toBeNull();
    expect(input.teamId).toBeNull();
  });

  it("fails fast when req.apiKey is missing (auth middleware did not run)", () => {
    const req = makeReq(null, { policy: "pool", platform: "anthropic" });
    expect(() => buildFailoverInput(req, db, { maxSwitches: 1, attempt })).toThrow(
      /req\.apiKey is missing/,
    );
  });

  it("fails fast when req.gwGroupContext is missing", () => {
    const req = makeReq(
      { orgId: "o", teamId: null, groupId: null, userId: "u" },
      null,
    );
    expect(() => buildFailoverInput(req, db, { maxSwitches: 1, attempt })).toThrow(
      /req\.gwGroupContext is missing/,
    );
  });

  it("assembles authHealth from req.server decorations", () => {
    const fakeRedis = { tag: "redis" };
    const authFailedTotal = { inc() {} };
    const credentialDegradedTotal = { inc() {} };
    const logger = { warn() {} };
    const req = makeReq(
      { orgId: "org-1", teamId: "team-9", groupId: "grp-7", userId: "user-byok-1" },
      { policy: "own", platform: "openai" },
      {
        redis: fakeRedis,
        gwMetrics: {
          upstreamAuthFailedTotal: authFailedTotal,
          upstreamCredentialDegradedTotal: credentialDegradedTotal,
        },
        env: {
          GATEWAY_UPSTREAM_AUTH_MAX_FAIL: 3,
          GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC: 3600,
          GATEWAY_UPSTREAM_AUTH_GRACE_SEC: 120,
        },
        log: logger,
      },
    );

    const input = buildFailoverInput(req, db, { maxSwitches: 1, attempt });

    expect(input.authHealth).toBeTruthy();
    expect(input.authHealth!.redis).toBe(fakeRedis);
    expect(input.authHealth!.maxFail).toBe(3);
    expect(input.authHealth!.backoffSec).toBe(3600);
    expect(input.authHealth!.graceSec).toBe(120);
    expect(input.authHealth!.metrics.authFailedTotal).toBe(authFailedTotal);
    expect(input.authHealth!.metrics.credentialDegradedTotal).toBe(
      credentialDegradedTotal,
    );
    expect(input.authHealth!.logger).toBe(logger);
  });

  it("authHealth is undefined when req.server.redis is absent", () => {
    const req = makeReq(
      { orgId: "o", teamId: null, groupId: null, userId: "u" },
      { policy: "pool", platform: "anthropic" },
      { env: {}, log: { warn() {} } },
    );

    const input = buildFailoverInput(req, db, { maxSwitches: 1, attempt });

    expect(input.authHealth).toBeUndefined();
  });
});
