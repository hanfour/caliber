# CLI Login + Resident Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members run `npm i -g @hanfour.huang/caliber && caliber login` → browser device-code approval → the Go `caliber-agent` is downloaded, enrolled non-interactively (watch-all, full-body, 90-day backfill), and installed as a launchd resident that uploads Claude Code / Codex transcripts continuously.

**Architecture:** Spec = `docs/superpowers/specs/2026-07-03-cli-login-resident-agent-design.md`. Server gains a Redis-backed device-code flow (REST start/poll + tRPC approve on the existing devices router) that terminates in the EXISTING enrollment-token → `cda_*` pipeline, plus one org column + `GET /v1/agent-config`. The Go agent gains non-interactive enroll, watch-all, a 90-day mtime cutoff, hourly config refresh, and launchd service commands. The TS CLI orchestrates everything.

**Tech Stack:** Fastify + zod + Drizzle + ioredis (api), Next.js App Router + shadcn/ui + next-intl (web), Go 1.25 + cobra (agent), commander + Node built-in fetch (CLI), GitHub Actions (release).

## Global Constraints

- Monorepo: pnpm@9.15.0, Node >= 20. Go 1.25.5 in `agent/` (stdlib `testing` only, coverage gate 80% via `agent/scripts/coverage.sh`).
- REST error convention: `reply.code(N); return { error: "snake_case_code" }` — never `reply.send()`.
- Redis keys get global prefix `caliber:gw:` automatically; key-builder helper + `*_TTL_SEC` const convention (see `apps/api/src/trpc/routers/apiKeys.ts:22-27`).
- Migrations: next number **0024**; `pnpm --filter @caliber/db db:generate` then hand-write `0024_down.sql`; never hand-edit `meta/_journal.json`.
- New web i18n strings go into ALL 5 catalogs `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` + extend the key-parity test.
- Go agent config dir = `CALIBER_AGENT_HOME` || `~/.caliber-agent`; atomic writes (`CreateTemp→Chmod 0600→Sync→Rename`); daemon exits 0 on config-gone sentinels (launchd-friendly, `run.go:284`).
- launchd label/plist name = `tw.caliber.agent` (matches keychain `ServiceName`; deviates from the spec's `net.miilink.caliber-agent` — repo-internal consistency wins).
- Agent redaction modes: `metadata-only | redacted-body | full-body`. Login enrolls with `full-body`.
- Interval clamp: **30–1800 seconds**, default **60**. Device-auth flow TTL **900 s**, poll interval **5 s**. Enrollment token TTL 3600 s (existing).
- TS CLI: stdout = report content, stderr = progress; `process.exitCode = 1` on error; chalk for color; sync `node:fs`; HTTP via built-in `fetch` (NO new deps).
- Commit style: `<type>: <description>`, no attribution footer.
- ⚠️ gh account reverts to `HanfourHuangOneAD` (no repo write) every turn — `gh auth switch --user hanfour && gh auth setup-git` before any push/merge.

---

### Task 1: api — device-auth flow store + `POST /v1/device-auth/start` + `POST /v1/device-auth/poll`

**Files:**
- Create: `apps/api/src/rest/deviceAuth.ts`
- Modify: `apps/api/src/server.ts` (register after the redis client is created, ~line 125)
- Test: `apps/api/tests/integration/rest/deviceAuth.test.ts`

**Interfaces:**
- Consumes: `ServerEnv` (`@caliber/config`), `Redis` (ioredis), `@fastify/rate-limit` (already a dep, used in `server.ts`).
- Produces (Task 2 imports these): `deviceAuthRoutes(env, redis): FastifyPluginAsync`, `hashDeviceCode(code: string): string`, `flowKey(hash: string): string`, `userCodeKey(userCode: string): string`, `deviceAuthFlowSchema` (zod), `type DeviceAuthFlow = { status: "pending"|"approved"|"denied"; userCode: string; hostname: string; os: string; agentVersion?: string; cliVersion?: string; createdAt: string; enrollmentToken?: string }`, `normalizeUserCode(raw: string): string`, `USER_CODE_RE`.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/integration/rest/deviceAuth.test.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  deviceAuthRoutes, hashDeviceCode, flowKey, userCodeKey,
} from "../../../src/rest/deviceAuth.js";
import { defaultTestEnv, makeTestRedis } from "../../factories/index.js";

const redis = makeTestRedis();
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(deviceAuthRoutes(defaultTestEnv, redis));
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await redis.flushall(); });

const startPayload = { hostname: "mbp-test", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" };

describe("POST /v1/device-auth/start", () => {
  it("201 returns RFC8628-shaped fields and stores a pending flow", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32B base64url
    expect(body.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/);
    expect(body.verification_uri).toBe(`${defaultTestEnv.NEXTAUTH_URL.replace(/\/$/, "")}/device`);
    expect(body.verification_uri_complete).toBe(`${body.verification_uri}?code=${body.user_code}`);
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(900);
    const raw = await redis.get(flowKey(hashDeviceCode(body.device_code)));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ status: "pending", userCode: body.user_code, hostname: "mbp-test" });
    expect(await redis.get(userCodeKey(body.user_code))).toBe(hashDeviceCode(body.device_code));
    expect(await redis.ttl(flowKey(hashDeviceCode(body.device_code)))).toBeGreaterThan(890);
  });
  it("400 on invalid body", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: { os: "darwin" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
  it("404 when gateway disabled", async () => {
    const off = Fastify({ logger: false });
    await off.register(deviceAuthRoutes({ ...defaultTestEnv, ENABLE_GATEWAY: false }, redis));
    const res = await off.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    expect(res.statusCode).toBe(404);
    await off.close();
  });
});

describe("POST /v1/device-auth/poll", () => {
  async function startFlow() {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/start", payload: startPayload });
    return res.json() as { device_code: string; user_code: string };
  }
  it("authorization_pending while pending", async () => {
    const { device_code } = await startFlow();
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("authorization_pending");
  });
  it("expired_token for unknown device_code", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code: "nope-nope-nope-nope" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("expired_token");
  });
  it("access_denied once denied, and the flow is deleted", async () => {
    const { device_code, user_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    const flow = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...flow, status: "denied" }), "EX", 900);
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.json().error).toBe("access_denied");
    expect(await redis.get(key)).toBeNull();
    expect(await redis.get(userCodeKey(user_code))).toBeNull();
  });
  it("returns enrollment_token exactly once when approved", async () => {
    const { device_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    const flow = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...flow, status: "approved", enrollmentToken: "tok_abc" }), "EX", 900);
    const ok = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().enrollment_token).toBe("tok_abc");
    const again = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(again.json().error).toBe("expired_token"); // single collection
  });
  it("expired_token on corrupt payload (and deletes it)", async () => {
    const { device_code } = await startFlow();
    const key = flowKey(hashDeviceCode(device_code));
    await redis.set(key, "{not json", "EX", 900);
    const res = await app.inject({ method: "POST", url: "/v1/device-auth/poll", payload: { device_code } });
    expect(res.json().error).toBe("expired_token");
    expect(await redis.get(key)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/rest/deviceAuth.test.ts --config vitest.integration.config.ts`
Expected: FAIL — cannot resolve `../../../src/rest/deviceAuth.js`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/rest/deviceAuth.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { ServerEnv } from "@caliber/config";

// RFC 8628-style device authorization grant, state in Redis (zero schema).
// Spec: docs/superpowers/specs/2026-07-03-cli-login-resident-agent-design.md §2
const FLOW_TTL_SEC = 900;
const POLL_INTERVAL_SEC = 5;
const RATE_LIMIT_PER_MIN = 60;
// Unambiguous alphabet: no vowels (no accidental words), no 0/O/1/I.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";
export const USER_CODE_RE = /^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/;

const startBodySchema = z.object({
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(255),
  agentVersion: z.string().max(64).optional(),
  cliVersion: z.string().max(64).optional(),
});
const pollBodySchema = z.object({ device_code: z.string().min(16).max(128) });

export const deviceAuthFlowSchema = z.object({
  status: z.enum(["pending", "approved", "denied"]),
  userCode: z.string(),
  hostname: z.string(),
  os: z.string(),
  agentVersion: z.string().optional(),
  cliVersion: z.string().optional(),
  createdAt: z.string(),
  enrollmentToken: z.string().optional(),
});
export type DeviceAuthFlow = z.infer<typeof deviceAuthFlowSchema>;

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
export function flowKey(deviceCodeHash: string): string {
  return `device-auth:${deviceCodeHash}`;
}
export function userCodeKey(userCode: string): string {
  return `device-auth:code:${userCode}`;
}
/** Uppercases, strips separators, re-inserts the dash: "abcd efgh" -> "ABCD-EFGH". */
export function normalizeUserCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-9]/g, "");
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}
function generateUserCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i += 1) s += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function deviceAuthRoutes(env: ServerEnv, redis: Redis): FastifyPluginAsync {
  return async (fastify) => {
    // First rate-limited REST scope in api (trpc has its own); per-IP.
    await fastify.register(rateLimit, {
      max: RATE_LIMIT_PER_MIN,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });

    fastify.post("/v1/device-auth/start", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const parsed = startBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body", details: parsed.error.flatten() };
      }
      const deviceCode = randomBytes(32).toString("base64url");
      const codeHash = hashDeviceCode(deviceCode);
      const userCode = generateUserCode();
      const flow: DeviceAuthFlow = {
        status: "pending",
        userCode,
        ...parsed.data,
        createdAt: new Date().toISOString(),
      };
      await redis.set(flowKey(codeHash), JSON.stringify(flow), "EX", FLOW_TTL_SEC);
      await redis.set(userCodeKey(userCode), codeHash, "EX", FLOW_TTL_SEC);
      const verificationUri = `${env.NEXTAUTH_URL.replace(/\/$/, "")}/device`;
      reply.code(201);
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?code=${userCode}`,
        interval: POLL_INTERVAL_SEC,
        expires_in: FLOW_TTL_SEC,
      };
    });

    fastify.post("/v1/device-auth/poll", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const parsed = pollBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_body" };
      }
      const codeHash = hashDeviceCode(parsed.data.device_code);
      const raw = await redis.get(flowKey(codeHash));
      if (!raw) {
        reply.code(400);
        return { error: "expired_token" };
      }
      let flow: DeviceAuthFlow;
      try {
        flow = deviceAuthFlowSchema.parse(JSON.parse(raw));
      } catch {
        await redis.del(flowKey(codeHash)).catch(() => {});
        reply.code(400);
        return { error: "expired_token" };
      }
      if (flow.status === "denied") {
        await redis.del(flowKey(codeHash), userCodeKey(flow.userCode)).catch(() => {});
        reply.code(400);
        return { error: "access_denied" };
      }
      if (flow.status === "approved" && flow.enrollmentToken) {
        await redis.del(flowKey(codeHash), userCodeKey(flow.userCode)).catch(() => {});
        reply.code(200);
        return { enrollment_token: flow.enrollmentToken };
      }
      reply.code(400);
      return { error: "authorization_pending" };
    });
  };
}
```

- [ ] **Step 4: Wire into `apps/api/src/server.ts`**

Add the import next to the other rest imports (~line 13):

```ts
import { deviceAuthRoutes } from "./rest/deviceAuth.js";
```

Register AFTER the redis client is created (the `redis` variable exists from ~line 109; place the register right after the redis creation block, ~line 125 — NOT in the :69-75 block, which runs before redis exists):

```ts
await app.register(deviceAuthRoutes(env, redis));
```

Note: when `!ENABLE_GATEWAY`, `redis` is the throwing-proxy placeholder — safe because both handlers 404 before touching redis.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/rest/deviceAuth.test.ts --config vitest.integration.config.ts`
Expected: PASS (8 tests). Also run `pnpm --filter @caliber/api typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rest/deviceAuth.ts apps/api/src/server.ts apps/api/tests/integration/rest/deviceAuth.test.ts
git commit -m "feat(api): device-auth start/poll REST endpoints (RFC8628-style, Redis flow state)"
```

---

### Task 2: api — tRPC `deviceAuth.lookup` + `deviceAuth.approve` + `deviceAuth.deny` on the devices router

The `/device` web page (Task 8) is session-authenticated, so approval runs through tRPC (cookie auth) — NOT a public REST route. Approve mints the EXISTING enrollment token (reusing `hashEnrollmentToken` + `deviceEnrollmentTokens` insert) and writes it into the Redis flow so `poll` (Task 1) can hand it back.

**Files:**
- Modify: `apps/api/src/trpc/routers/devices.ts` (add a `deviceAuth` sub-router; the file must reach redis — see Step 3 for the context wiring note)
- Modify: `apps/api/src/services/auditActions.ts` (add `DEVICE_AUTH_APPROVED`, `DEVICE_AUTH_DENIED`)
- Test: `apps/api/tests/integration/trpc/deviceAuth.test.ts`

**Interfaces:**
- Consumes: `hashDeviceCode`, `flowKey`, `userCodeKey`, `normalizeUserCode`, `USER_CODE_RE`, `deviceAuthFlowSchema`, `type DeviceAuthFlow` (Task 1); `hashEnrollmentToken` (`devices.ts`); `resolveUserPrimaryOrgId` (`_shared.ts`); `ctx.redis` (tRPC context already carries it — `context.ts:63`).
- Produces: tRPC procedures `devices.deviceAuth.lookup({ userCode }) -> { hostname, os, agentVersion?, cliVersion? }`, `devices.deviceAuth.approve({ userCode }) -> { ok: true }`, `devices.deviceAuth.deny({ userCode }) -> { ok: true }`.

- [ ] **Step 1: Write the failing test**

`apps/api/tests/integration/trpc/deviceAuth.test.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb, makeOrg, makeUser, callerFor, makeTestRedis } from "../../factories/index.js";
import { hashDeviceCode, flowKey, userCodeKey } from "../../../src/rest/deviceAuth.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
const redis = makeTestRedis();
let orgId: string;
let userId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  orgId = await makeOrg(testDb.db);
  userId = await makeUser(testDb.db, { orgId });
});
afterAll(async () => { await testDb.stop(); });
beforeEach(async () => { await redis.flushall(); });

async function seedPending(userCode = "BCDF-GHJK") {
  const deviceCode = "dc_" + userCode;
  const codeHash = hashDeviceCode(deviceCode);
  const flow = { status: "pending", userCode, hostname: "mbp", os: "darwin", agentVersion: "0.2.0", createdAt: new Date().toISOString() };
  await redis.set(flowKey(codeHash), JSON.stringify(flow), "EX", 900);
  await redis.set(userCodeKey(userCode), codeHash, "EX", 900);
  return { deviceCode, codeHash };
}

describe("devices.deviceAuth", () => {
  it("lookup returns device metadata for a pending flow", async () => {
    await seedPending();
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId });
    const res = await caller.devices.deviceAuth.lookup({ userCode: "bcdf ghjk" }); // normalized
    expect(res).toMatchObject({ hostname: "mbp", os: "darwin" });
  });
  it("lookup throws NOT_FOUND for unknown code", async () => {
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId });
    await expect(caller.devices.deviceAuth.lookup({ userCode: "ZZZZ-ZZZZ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("approve writes an enrollment token into the flow and inserts a DB row", async () => {
    const { codeHash } = await seedPending();
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId });
    const res = await caller.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" });
    expect(res.ok).toBe(true);
    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("approved");
    expect(typeof flow.enrollmentToken).toBe("string");
    expect(flow.enrollmentToken.length).toBeGreaterThan(20);
  });
  it("approve is idempotent-safe: second approve throws PRECONDITION_FAILED", async () => {
    await seedPending();
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId });
    await caller.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" });
    await expect(caller.devices.deviceAuth.approve({ userCode: "BCDF-GHJK" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
  it("deny marks the flow denied", async () => {
    const { codeHash } = await seedPending();
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId });
    await caller.devices.deviceAuth.deny({ userCode: "BCDF-GHJK" });
    const flow = JSON.parse((await redis.get(flowKey(codeHash)))!);
    expect(flow.status).toBe("denied");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/trpc/deviceAuth.test.ts --config vitest.integration.config.ts`
Expected: FAIL — `caller.devices.deviceAuth` is undefined.

- [ ] **Step 3: Add audit action constants**

In `apps/api/src/services/auditActions.ts`, add to the `AUDIT_ACTIONS` object (match the existing `DEVICE_SELF_REVOKED` style):

```ts
  DEVICE_AUTH_APPROVED: "device_auth.approved",
  DEVICE_AUTH_DENIED: "device_auth.denied",
```

- [ ] **Step 4: Add the `deviceAuth` sub-router to `apps/api/src/trpc/routers/devices.ts`**

Add imports at the top of the file:

```ts
import { resolveUserPrimaryOrgId } from "./_shared.js";
import { AUDIT_ACTIONS } from "../../services/auditActions.js";
import {
  hashDeviceCode, flowKey, userCodeKey, normalizeUserCode, USER_CODE_RE,
  deviceAuthFlowSchema, type DeviceAuthFlow,
} from "../../rest/deviceAuth.js";
```

Add this sub-router inside the `router({ ... })` object passed to `export const devicesRouter` (alongside `enrollmentToken`). It reuses the existing `generateEnrollmentToken` / `hashEnrollmentToken` / `ENROLLMENT_TOKEN_TTL_SEC` already in the file:

```ts
  // Device-code authorization: the /device web page (session auth) approves a
  // CLI login flow started via POST /v1/device-auth/start. Approve mints the
  // SAME enrollment token the dashboard dialog issues, writing it into the
  // Redis flow so POST /v1/device-auth/poll can return it to the CLI.
  deviceAuth: router({
    lookup: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const flow = await readPendingFlow(ctx.redis, input.userCode);
        return {
          hostname: flow.hostname,
          os: flow.os,
          agentVersion: flow.agentVersion,
          cliVersion: flow.cliVersion,
        };
      }),

    approve: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const pepper = requirePepper(ctx.env);
        const userCode = normalizeUserCode(input.userCode);
        const { flow, codeHash } = await readPendingFlowWithHash(ctx.redis, userCode);
        const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

        const token = generateEnrollmentToken();
        const tokenHash = hashEnrollmentToken(pepper, token);
        const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000);
        const [row] = await ctx.db
          .insert(deviceEnrollmentTokens)
          .values({ userId: ctx.user.id, orgId, tokenHash, expiresAt })
          .returning({ id: deviceEnrollmentTokens.id });
        if (!row) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "failed to insert enrollment token" });
        }

        const approved: DeviceAuthFlow = { ...flow, status: "approved", enrollmentToken: token };
        const ttl = await ctx.redis.ttl(flowKey(codeHash));
        await ctx.redis.set(flowKey(codeHash), JSON.stringify(approved), "EX", ttl > 0 ? ttl : 60);

        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: AUDIT_ACTIONS.DEVICE_AUTH_APPROVED,
          targetType: "enrollment_token",
          targetId: row.id,
          orgId,
          metadata: { hostname: flow.hostname, os: flow.os },
        });
        return { ok: true as const };
      }),

    deny: protectedProcedure
      .input(z.object({ userCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        ensureGatewayEnabled(ctx.env);
        const userCode = normalizeUserCode(input.userCode);
        const { flow, codeHash } = await readPendingFlowWithHash(ctx.redis, userCode);
        const denied: DeviceAuthFlow = { ...flow, status: "denied" };
        const ttl = await ctx.redis.ttl(flowKey(codeHash));
        await ctx.redis.set(flowKey(codeHash), JSON.stringify(denied), "EX", ttl > 0 ? ttl : 60);
        await writeAudit(ctx.db, {
          actorUserId: ctx.user.id,
          action: AUDIT_ACTIONS.DEVICE_AUTH_DENIED,
          orgId: null,
          metadata: { hostname: flow.hostname },
        });
        return { ok: true as const };
      }),
  }),
```

Add these module-level helpers near the top of `devices.ts` (after `generateEnrollmentToken`). They resolve the user_code → flow, throwing tRPC errors on miss/expired/already-decided:

```ts
async function readPendingFlowWithHash(
  redis: import("ioredis").Redis,
  rawUserCode: string,
): Promise<{ flow: DeviceAuthFlow; codeHash: string }> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!USER_CODE_RE.test(userCode)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  const codeHash = await redis.get(userCodeKey(userCode));
  if (!codeHash) throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  const raw = await redis.get(flowKey(codeHash));
  if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  let flow: DeviceAuthFlow;
  try {
    flow = deviceAuthFlowSchema.parse(JSON.parse(raw));
  } catch {
    throw new TRPCError({ code: "NOT_FOUND", message: "unknown code" });
  }
  if (flow.status !== "pending") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "already decided" });
  }
  return { flow, codeHash };
}

async function readPendingFlow(
  redis: import("ioredis").Redis,
  rawUserCode: string,
): Promise<DeviceAuthFlow> {
  return (await readPendingFlowWithHash(redis, rawUserCode)).flow;
}
```

Note: `lookup`/`approve`/`deny` use `protectedProcedure` (any authenticated member can approve their OWN device — the enrolled device binds to the approver's user/org, which is the intended trust model per spec §2). No org-admin gate.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/trpc/deviceAuth.test.ts --config vitest.integration.config.ts`
Expected: PASS (5 tests). Run `pnpm --filter @caliber/api typecheck`.

Note on the test harness: `callerFor` must accept a `redis` override. Verify `apps/api/tests/factories/caller.ts` already threads `redis` into the context (the report says `defaultTestRedis`/`makeTestRedis()` exist). If `callerFor` does not accept `redis`, add it: default to `defaultTestRedis` and pass through to `createContextFactory`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/devices.ts apps/api/src/services/auditActions.ts apps/api/tests/integration/trpc/deviceAuth.test.ts
git commit -m "feat(api): deviceAuth.lookup/approve/deny tRPC procedures (mint enrollment token into flow)"
```

---

### Task 3: db — `organizations.agent_poll_interval_seconds` column + migration 0024

**Files:**
- Modify: `packages/db/src/schema/org.ts` (add the column to the `organizations` table)
- Create: `packages/db/drizzle/0024_*.sql` (via generator) + `packages/db/drizzle/0024_down.sql` (hand-written)
- Test: `apps/api/tests/integration/migrations/0024.test.ts`

**Interfaces:**
- Produces: `organizations.agentPollIntervalSeconds` (nullable integer; `NULL` = use the server default 60).

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema/org.ts`, inside the `organizations = pgTable("organizations", {...})` object, add after `llmHaltedAt`:

```ts
  agentPollIntervalSeconds: integer("agent_poll_interval_seconds"),
```

(`integer` is already imported in this file — verify; if not, add it to the `drizzle-orm/pg-core` import.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @caliber/db db:generate`
Expected: creates `packages/db/drizzle/0024_<name>.sql` containing `ALTER TABLE "organizations" ADD COLUMN "agent_poll_interval_seconds" integer;` plus a `meta/0024_snapshot.json` and a `_journal.json` entry. Do NOT hand-edit the journal.

- [ ] **Step 3: Hand-write the down migration**

Create `packages/db/drizzle/0024_down.sql`:

```sql
-- down: organizations.agent_poll_interval_seconds rollback
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "agent_poll_interval_seconds";
```

Also prepend the `-- down:` summary comment to the top of the generated `0024_*.sql` (match `0023_keen_energizer.sql:1-2` convention):

```sql
-- down: 0024_down.sql — drop organizations.agent_poll_interval_seconds
```

- [ ] **Step 4: Write the migration test**

`apps/api/tests/integration/migrations/0024.test.ts` (mirror `0023.test.ts` structure — start a container, migrate, assert the column exists with the right type and nullability):

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => { testDb = await setupTestDb(); });
afterAll(async () => { await testDb.stop(); });

describe("migration 0024", () => {
  it("adds nullable agent_poll_interval_seconds to organizations", async () => {
    const { rows } = await testDb.pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'agent_poll_interval_seconds'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("integer");
    expect(rows[0].is_nullable).toBe("YES");
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/migrations/0024.test.ts --config vitest.integration.config.ts`
Expected: PASS. Run `pnpm --filter @caliber/db typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/org.ts packages/db/drizzle/0024_*.sql packages/db/drizzle/0024_down.sql packages/db/drizzle/meta apps/api/tests/integration/migrations/0024.test.ts
git commit -m "feat(db): add organizations.agent_poll_interval_seconds (migration 0024)"
```

---

### Task 4: api — `GET /v1/agent-config` + `deviceAuth` org-admin interval setter

The agent fetches its poll interval here (Bearer `cda_*`, mirroring `/v1/redaction-set`). The dashboard sets it via a tRPC mutation gated on `org_admin`.

**Files:**
- Create: `apps/api/src/rest/agentConfig.ts`
- Modify: `apps/api/src/server.ts` (register the route)
- Modify: `apps/api/src/trpc/routers/devices.ts` (add `deviceAuth.getOrgConfig` query + `deviceAuth.setOrgConfig` mutation — or a small `agentConfig` sub-router; see Step 4)
- Test: `apps/api/tests/integration/rest/agentConfig.test.ts`, extend `apps/api/tests/integration/trpc/deviceAuth.test.ts`

**Interfaces:**
- Consumes: `resolveDeviceFromAuth` (`ingestAuth.ts`), `organizations` (`@caliber/db`), `can`/`org_admin` RBAC.
- Produces: REST `agentConfigRoutes(env): FastifyPluginAsync` returning `{ poll_interval_seconds, ttl_seconds }`; tRPC `devices.agentConfig.get({ orgId }) -> { pollIntervalSeconds: number }`, `devices.agentConfig.set({ orgId, pollIntervalSeconds }) -> { ok: true }`. Interval clamp constants `AGENT_POLL_MIN_SEC=30`, `AGENT_POLL_MAX_SEC=1800`, `AGENT_POLL_DEFAULT_SEC=60`, `AGENT_CONFIG_TTL_SEC=3600`.

- [ ] **Step 1: Write the failing REST test**

`apps/api/tests/integration/rest/agentConfig.test.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import { agentConfigRoutes } from "../../../src/rest/agentConfig.js";
import { setupTestDb, makeOrg, makeUser, defaultTestEnv } from "../../factories/index.js";
import { devices, deviceApiKeys, organizations } from "@caliber/db";
import { eq } from "drizzle-orm";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;
let rawKey: string;
let orgId: string;

beforeAll(async () => {
  testDb = await setupTestDb();
  orgId = await makeOrg(testDb.db);
  const userId = await makeUser(testDb.db, { orgId });
  const [dev] = await testDb.db.insert(devices).values({
    userId, orgId, hostname: "h", os: "darwin", agentVersion: "0.2.0", status: "active",
  }).returning({ id: devices.id });
  rawKey = generateDeviceKey();
  await testDb.db.insert(deviceApiKeys).values({
    deviceId: dev!.id, keyHash: hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, rawKey), keyPrefix: rawKey.slice(0, 12),
  });
  app = Fastify({ logger: false });
  await app.register(agentConfigRoutes(defaultTestEnv));
  await app.ready();
});
afterAll(async () => { await app.close(); await testDb.stop(); });

describe("GET /v1/agent-config", () => {
  it("401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agent-config" });
    expect(res.statusCode).toBe(401);
  });
  it("returns the default interval when org column is null", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agent-config", headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ poll_interval_seconds: 60, ttl_seconds: 3600 });
  });
  it("returns the org-configured interval", async () => {
    await testDb.db.update(organizations).set({ agentPollIntervalSeconds: 300 }).where(eq(organizations.id, orgId));
    const res = await app.inject({ method: "GET", url: "/v1/agent-config", headers: { authorization: `Bearer ${rawKey}` } });
    expect(res.json().poll_interval_seconds).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/rest/agentConfig.test.ts --config vitest.integration.config.ts`
Expected: FAIL — cannot resolve `agentConfig.js`.

- [ ] **Step 3: Write the REST route**

`apps/api/src/rest/agentConfig.ts`:

```ts
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { organizations } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuth } from "./ingestAuth.js";

export const AGENT_POLL_MIN_SEC = 30;
export const AGENT_POLL_MAX_SEC = 1800;
export const AGENT_POLL_DEFAULT_SEC = 60;
export const AGENT_CONFIG_TTL_SEC = 3600;

export function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return AGENT_POLL_DEFAULT_SEC;
  return Math.min(AGENT_POLL_MAX_SEC, Math.max(AGENT_POLL_MIN_SEC, Math.round(n)));
}

export function agentConfigRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/v1/agent-config", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const auth = await resolveDeviceFromAuth(fastify.db, env, req.headers.authorization);
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          reply.code(500);
          return { error: "server_misconfigured" };
        }
        reply.code(401);
        return { error: auth.error };
      }
      const [row] = await fastify.db
        .select({ interval: organizations.agentPollIntervalSeconds })
        .from(organizations)
        .where(eq(organizations.id, auth.device.orgId))
        .limit(1);
      const interval = row?.interval == null ? AGENT_POLL_DEFAULT_SEC : clampInterval(row.interval);
      reply.code(200);
      return { poll_interval_seconds: interval, ttl_seconds: AGENT_CONFIG_TTL_SEC };
    });
  };
}
```

- [ ] **Step 4: Add the tRPC setter/getter to `devices.ts`**

Add an `agentConfig` sub-router alongside `deviceAuth`. Import the clamp + constants from the REST module (`import { clampInterval, AGENT_POLL_DEFAULT_SEC } from "../../rest/agentConfig.js";`) and `organizations` from `@caliber/db`:

```ts
  agentConfig: router({
    get: permissionProcedure(
      z.object({ orgId: uuid }),
      (input) => ({ type: "device.list_all", orgId: input.orgId }),
    ).query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ interval: organizations.agentPollIntervalSeconds })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);
      return { pollIntervalSeconds: row?.interval ?? AGENT_POLL_DEFAULT_SEC };
    }),
    set: permissionProcedure(
      z.object({ orgId: uuid, pollIntervalSeconds: z.number().int() }),
      (input) => ({ type: "device.list_all", orgId: input.orgId }),
    ).mutation(async ({ ctx, input }) => {
      const clamped = clampInterval(input.pollIntervalSeconds);
      await ctx.db
        .update(organizations)
        .set({ agentPollIntervalSeconds: clamped })
        .where(eq(organizations.id, input.orgId));
      await writeAudit(ctx.db, {
        actorUserId: ctx.user.id,
        action: "device_auth.config_set",
        orgId: input.orgId,
        metadata: { pollIntervalSeconds: clamped },
      });
      return { ok: true as const, pollIntervalSeconds: clamped };
    }),
  }),
```

Add `import { organizations } from "@caliber/db";` (extend the existing `@caliber/db` import) and add `device_auth.config_set` to `auditActions.ts` if you prefer a constant (optional — the string is inline above; for consistency add `DEVICE_AUTH_CONFIG_SET: "device_auth.config_set"` and reference it).

Uses `device.list_all` as the permission action (already `org_admin`-gated per the RBAC report — reusing it avoids a new action). Register `agentConfigRoutes(env)` in `server.ts` next to the other REST registrations (~line 75; this one needs only `fastify.db`, no redis).

- [ ] **Step 5: Extend the tRPC test + run**

Add to `apps/api/tests/integration/trpc/deviceAuth.test.ts`:

```ts
describe("devices.agentConfig", () => {
  it("get returns default 60 when unset; set clamps out-of-range", async () => {
    const caller = callerFor({ db: testDb.db, redis, user: { id: userId, email: "u@x.co" }, orgId, perm: /* org_admin perm for orgId */ undefined });
    // NOTE: callerFor must grant org_admin on orgId for device.list_all to pass.
    expect((await caller.devices.agentConfig.get({ orgId })).pollIntervalSeconds).toBe(60);
    const set = await caller.devices.agentConfig.set({ orgId, pollIntervalSeconds: 5 });
    expect(set.pollIntervalSeconds).toBe(30); // clamped to min
    expect((await caller.devices.agentConfig.get({ orgId })).pollIntervalSeconds).toBe(30);
  });
});
```

Grant the caller `org_admin` on `orgId` — check how existing org-admin tRPC tests build the caller (search `org_admin` in `apps/api/tests`); replicate that assignment seeding.

Run: `pnpm --filter @caliber/api exec vitest run tests/integration/rest/agentConfig.test.ts tests/integration/trpc/deviceAuth.test.ts --config vitest.integration.config.ts`
Expected: PASS. Run `pnpm --filter @caliber/api typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rest/agentConfig.ts apps/api/src/server.ts apps/api/src/trpc/routers/devices.ts apps/api/src/services/auditActions.ts apps/api/tests/integration/rest/agentConfig.test.ts apps/api/tests/integration/trpc/deviceAuth.test.ts
git commit -m "feat(api): GET /v1/agent-config + org-admin poll-interval setter"
```

---

### Task 5: Go agent — non-interactive enroll (`--yes --watch-all --mode`)

`caliber login` must enroll without TTY prompts. Add a non-interactive Prompter that auto-answers and, with `--watch-all`, seeds both roots.

**Files:**
- Modify: `agent/internal/cli/enroll.go` (add flags + non-interactive prompter selection)
- Create: `agent/internal/wizard/prompt_auto.go` (an `AutoPrompter`)
- Modify: `agent/internal/wizard/enroll.go` (support a watch-all path set)
- Test: `agent/internal/cli/enroll_noninteractive_test.go`, `agent/internal/wizard/prompt_auto_test.go`

**Interfaces:**
- Consumes: `wizard.Prompter` interface (`Confirm/SelectMulti/InputLine`), `wizard.Deps`, `config.SaveConfig`.
- Produces: `enroll` flags `--yes` (bool), `--watch-all` (bool), `--mode` (string, one of the three redaction modes, default `full-body` when `--yes`); `wizard.AutoPrompter` (Confirm→true, SelectMulti→all indices, InputLine→"").

- [ ] **Step 1: Write the failing AutoPrompter test**

`agent/internal/wizard/prompt_auto_test.go`:

```go
package wizard

import "testing"

func TestAutoPrompter(t *testing.T) {
	p := AutoPrompter{}
	ok, err := p.Confirm("proceed?", false)
	if err != nil || !ok {
		t.Fatalf("Confirm = %v, %v; want true, nil", ok, err)
	}
	sel, err := p.SelectMulti("pick", []string{"a", "b", "c"})
	if err != nil || len(sel) != 3 || sel[0] != 0 || sel[2] != 2 {
		t.Fatalf("SelectMulti = %v, %v; want [0 1 2], nil", sel, err)
	}
	line, err := p.InputLine("name")
	if err != nil || line != "" {
		t.Fatalf("InputLine = %q, %v; want \"\", nil", line, err)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/wizard/ -run TestAutoPrompter`
Expected: FAIL — `AutoPrompter` undefined.

- [ ] **Step 3: Implement AutoPrompter**

`agent/internal/wizard/prompt_auto.go`:

```go
package wizard

// AutoPrompter answers every prompt non-interactively for `caliber login`:
// confirmations pass, multi-selects choose everything, free text is empty.
type AutoPrompter struct{}

func (AutoPrompter) Confirm(_ string, _ bool) (bool, error) { return true, nil }

func (AutoPrompter) SelectMulti(_ string, opts []string) ([]int, error) {
	idx := make([]int, len(opts))
	for i := range opts {
		idx[i] = i
	}
	return idx, nil
}

func (AutoPrompter) InputLine(_ string) (string, error) { return "", nil }
```

- [ ] **Step 4: Add flags + watch-all to enroll.go**

In `agent/internal/cli/enroll.go`, add to `newEnrollCmd()` flag block (near `:39-42`):

```go
	cmd.Flags().Bool("yes", false, "non-interactive: accept all prompts (for caliber login)")
	cmd.Flags().Bool("watch-all", false, "watch the entire Claude/Codex roots instead of prompting for paths")
	cmd.Flags().String("mode", "", "redaction mode: metadata-only|redacted-body|full-body (default full-body with --yes)")
```

In `runEnroll`, after resolving flags, select the prompter (replace the `:86-89` prompter block):

```go
	yes, _ := cmd.Flags().GetBool("yes")
	watchAll, _ := cmd.Flags().GetBool("watch-all")
	mode, _ := cmd.Flags().GetString("mode")
	if yes && mode == "" {
		mode = "full-body"
	}
	var prompter wizard.Prompter = wizard.NewStdinPrompter()
	if testPrompterHook != nil {
		prompter = testPrompterHook
	} else if yes {
		prompter = wizard.AutoPrompter{}
	}
```

Thread `WatchAll` and `Mode` into `wizard.Deps` (add these fields to the `Deps` struct in `wizard/enroll.go`):

```go
	WatchAll bool
	Mode     string // "" = wizard default (metadata-only); non-empty overrides
```

In `wizard/enroll.go` `RunEnrollWizard`, after `SaveConfigInitial` and before the `SelectMulti` path (`:97-103`), branch:

```go
	if d.WatchAll {
		roots := watchAllRoots(d.ClaudeProjectsRoot) // claude projects root + codex sessions root
		cfg.IncludePaths = roots
		if d.Mode != "" {
			cfg.Mode = d.Mode
		}
		return config.SaveConfig(cfg)
	}
```

Add a `watchAllRoots` helper in `wizard/enroll.go` that returns the canonicalized (`filepath.EvalSymlinks`+`Clean`) Claude projects root and Codex sessions root. Codex root = `~/.codex/sessions` (from `codexSessionsRoot()` in `run.go`); expose that or duplicate the `filepath.Join(home, ".codex", "sessions")` computation. When `--yes` but not `--watch-all`, keep the interactive default (empty include paths) — but `caliber login` always passes both.

- [ ] **Step 5: Write the enroll integration test**

`agent/internal/cli/enroll_noninteractive_test.go` — enroll against an httptest server, assert config has both roots + `full-body`:

```go
package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestEnroll_NonInteractive_WatchAll(t *testing.T) {
	home := setupRoot(t) // sets CALIBER_AGENT_HOME + fake `security`
	srv := enrollServer(t) // httptest server returning 201 {device_id,key,key_prefix}
	defer srv.Close()

	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--yes", "--watch-all"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mode != "full-body" {
		t.Errorf("Mode = %q, want full-body", cfg.Mode)
	}
	if len(cfg.IncludePaths) < 2 {
		t.Errorf("IncludePaths = %v, want >=2 (claude+codex roots)", cfg.IncludePaths)
	}
	_ = home
	_ = filepath.Join
	_ = os.Stat
}
```

Reuse the existing `enrollServer`/`setupRoot` helpers if present (the report cites `setupEnrolledRoot`/`setupRoot` in `run_test.go` and `handlerReturning` in `api/enroll_test.go`); if `enrollServer` doesn't exist, write a small `httptest.NewServer` returning the 201 enroll JSON.

- [ ] **Step 6: Run to verify it passes**

Run: `cd agent && go test ./internal/wizard/ ./internal/cli/ -run 'AutoPrompter|NonInteractive'`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/wizard/prompt_auto.go agent/internal/wizard/enroll.go agent/internal/cli/enroll.go agent/internal/wizard/prompt_auto_test.go agent/internal/cli/enroll_noninteractive_test.go
git commit -m "feat(agent): non-interactive enroll (--yes --watch-all --mode) for caliber login"
```

---

### Task 6: Go agent — 90-day backfill mtime filter

New watched files older than a fixed cutoff (enroll time − 90d) are skipped at discovery. The cutoff is persisted, not rolling.

**Files:**
- Modify: `agent/internal/config/config.go` (add `BackfillCutoff` field)
- Modify: `agent/internal/wizard/enroll.go` (set cutoff = now − backfillDays at enroll)
- Modify: `agent/internal/cli/enroll.go` (add `--backfill-days` flag, default 90)
- Modify: `agent/watcher/sources.go` (add `ModTime time.Time` to `FileRef`)
- Modify: `agent/watcher/claude.go`, `agent/watcher/codex.go` (populate `ModTime` via `os.Stat`)
- Modify: `agent/watcher/loop.go` (skip refs with `ModTime` before cutoff, unless already watermarked)
- Test: `agent/watcher/backfill_test.go`, `agent/internal/config/config_test.go` (cutoff round-trip)

**Interfaces:**
- Consumes: `FileRef`, `config.Config`, loop watermark map (`l.state.Files`).
- Produces: `config.Config.BackfillCutoff time.Time` (toml `backfill_cutoff,omitempty`); `FileRef.ModTime time.Time`; loop rule: skip when `!cutoff.IsZero() && ref.ModTime.Before(cutoff) && watermark absent`.

- [ ] **Step 1: Write the failing loop test**

`agent/watcher/backfill_test.go`:

```go
package watcher

import (
	"testing"
	"time"
)

func TestBackfillFilter(t *testing.T) {
	cutoff := time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC) // ~90d before a 2026-07-03 enroll
	old := FileRef{Path: "/x/old.jsonl", ModTime: cutoff.Add(-24 * time.Hour)}
	fresh := FileRef{Path: "/x/new.jsonl", ModTime: cutoff.Add(24 * time.Hour)}

	if !skipForBackfill(old, cutoff, map[string]bool{}) {
		t.Error("old file (before cutoff, unwatched) should be skipped")
	}
	if skipForBackfill(fresh, cutoff, map[string]bool{}) {
		t.Error("fresh file should not be skipped")
	}
	// already-watched old file is NOT skipped (we keep tailing what we started)
	if skipForBackfill(old, cutoff, map[string]bool{"/x/old.jsonl": true}) {
		t.Error("already-watched old file should not be skipped")
	}
	// zero cutoff (legacy enroll) disables filtering
	if skipForBackfill(old, time.Time{}, map[string]bool{}) {
		t.Error("zero cutoff should disable backfill filtering")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./watcher/ -run TestBackfillFilter`
Expected: FAIL — `skipForBackfill` undefined, `FileRef.ModTime` undefined.

- [ ] **Step 3: Add `ModTime` to FileRef + populate in sources**

In `agent/watcher/sources.go`, add to `FileRef`:

```go
	ModTime time.Time // file mtime, for backfill cutoff filtering
```

(add `"time"` import). In `claude.go` and `codex.go`, where each `*.jsonl` is confirmed a regular file (the existing `os.Lstat` guard sites), capture the mtime. The `Lstat` already returns a `FileInfo` — reuse it: set `ref.ModTime = info.ModTime()` when building each `FileRef`. (For symlink-guarded reads the code uses `Lstat`; `Lstat` on a regular file returns its own mtime, which is correct here.)

- [ ] **Step 4: Add `skipForBackfill` + wire into loop**

In `agent/watcher/loop.go`, add the helper:

```go
// skipForBackfill reports whether a newly-discovered file should be skipped
// because it predates the persisted backfill cutoff. Files already being
// tracked (present in the watermark map) are never skipped — we keep tailing
// what we've started. A zero cutoff (legacy enrol) disables the filter.
func skipForBackfill(ref FileRef, cutoff time.Time, watched map[string]bool) bool {
	if cutoff.IsZero() {
		return false
	}
	if watched[ref.Path] {
		return false
	}
	return ref.ModTime.Before(cutoff)
}
```

In `Tick`, right before reading the watermark (`wm := l.state.Files[ref.Path]`, loop.go:152), insert:

```go
			_, tracked := l.state.Files[ref.Path]
			if skipForBackfill(ref, l.config.BackfillCutoff, map[string]bool{ref.Path: tracked}) {
				continue
			}
```

(`l.config` is `*config.Config`; `BackfillCutoff` added in Step 5. Add `"time"` import to loop.go if not present.)

- [ ] **Step 5: Add cutoff to config + enroll flag**

In `agent/internal/config/config.go` `Config` struct, add:

```go
	BackfillCutoff time.Time `toml:"backfill_cutoff,omitempty"`
```

(add `"time"` import). In `agent/internal/cli/enroll.go`, add the flag:

```go
	cmd.Flags().Int("backfill-days", 90, "only backfill sessions modified within this many days (0 = from now)")
```

Pass it into `wizard.Deps` (add `BackfillDays int`) and in `RunEnrollWizard`, when building the initial config (before `SaveConfigInitial`), set:

```go
	if d.BackfillDays > 0 {
		cfg.BackfillCutoff = d.now().AddDate(0, 0, -d.BackfillDays)
	}
```

Add a `now func() time.Time` to `Deps` defaulting to `time.Now` (mirror the loop's `Now` seam for testability); or use `time.Now()` directly if the wizard has no clock seam yet — a direct call is acceptable here since the value is persisted once.

- [ ] **Step 6: Config round-trip test + run**

Add to `agent/internal/config/config_test.go` a test that saves a config with a non-zero `BackfillCutoff` and reloads it, asserting the time survives (TOML round-trips RFC3339). Then:

Run: `cd agent && go test ./watcher/ ./internal/config/ ./internal/cli/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/watcher/sources.go agent/watcher/claude.go agent/watcher/codex.go agent/watcher/loop.go agent/watcher/backfill_test.go agent/internal/config/config.go agent/internal/config/config_test.go agent/internal/cli/enroll.go agent/internal/wizard/enroll.go
git commit -m "feat(agent): 90-day backfill mtime cutoff at discovery"
```

---

### Task 7: Go agent — hourly agent-config fetch + dynamic poll interval

Mirror the redaction-set fetch/cache/provider pattern so the run loop's tick interval follows the server value, refreshed hourly.

**Files:**
- Create: `agent/internal/api/agentconfig.go` (fetch client)
- Create: `agent/internal/config/agentconfig.go` (disk cache load/save)
- Modify: `agent/internal/cli/run.go` (bootstrap + refresher goroutine + pass a mutable interval into the loop)
- Modify: `agent/watcher/loop.go` (read interval from a provider instead of the fixed field)
- Test: `agent/internal/api/agentconfig_test.go`, `agent/watcher/loop_interval_test.go`

**Interfaces:**
- Consumes: `api.Client` (BaseURL, HTTP, UserAgent), keychain `cda_*` token, `RedactionSetProvider` pattern (`sync.RWMutex`).
- Produces: `api.FetchAgentConfig(ctx, token) (*AgentConfigResponse, error)` where `AgentConfigResponse = { PollIntervalSeconds int64 `json:"poll_interval_seconds"`; TTLSeconds int64 `json:"ttl_seconds"` }`; `config.LoadAgentConfig()/SaveAgentConfig(*AgentConfig)`; `watcher.IntervalProvider` with `Current() time.Duration` / `Set(time.Duration)`.

- [ ] **Step 1: Write the failing fetch test**

`agent/internal/api/agentconfig_test.go` (mirror `enroll_test.go` — httptest server, assert bearer header + parsed fields):

```go
package api

import (
	"context"
	"net/http"
	"testing"
)

func TestFetchAgentConfig(t *testing.T) {
	srv := handlerReturning(http.StatusOK, `{"poll_interval_seconds":300,"ttl_seconds":3600}`)
	defer srv.Close()
	c := NewClient(srv.URL, "caliber-agent/test")
	resp, err := c.FetchAgentConfig(context.Background(), "cda_token")
	if err != nil {
		t.Fatalf("FetchAgentConfig: %v", err)
	}
	if resp.PollIntervalSeconds != 300 || resp.TTLSeconds != 3600 {
		t.Fatalf("got %+v", resp)
	}
}
```

(If `handlerReturning` doesn't assert the Authorization header, add a variant that records the request and assert `req.Header.Get("Authorization") == "Bearer cda_token"`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/api/ -run TestFetchAgentConfig`
Expected: FAIL — `FetchAgentConfig` undefined.

- [ ] **Step 3: Implement the fetch client**

`agent/internal/api/agentconfig.go` (copy `redactionset.go` structure exactly, change URL + response type):

```go
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type AgentConfigResponse struct {
	PollIntervalSeconds int64 `json:"poll_interval_seconds"`
	TTLSeconds          int64 `json:"ttl_seconds"`
}

func (c *Client) FetchAgentConfig(ctx context.Context, token string) (*AgentConfigResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/agent-config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		tag := parseErrorTag(body) // reuse the same helper redactionset.go uses
		return nil, &APIError{StatusCode: resp.StatusCode, ErrorTag: tag, Body: string(body)}
	}
	var out AgentConfigResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode agent-config: %w", err)
	}
	return &out, nil
}
```

(Match `redactionset.go`'s exact error-parsing helper name; if it inlines the `{error}` decode, inline it identically here.)

- [ ] **Step 4: Implement the disk cache**

`agent/internal/config/agentconfig.go` (mirror `redactionset.go` disk cache — atomic write, `AgentConfigPath()` = `<RootDir>/agent-config.json`):

```go
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type AgentConfig struct {
	PollIntervalSeconds int64     `json:"poll_interval_seconds"`
	TTLSeconds          int64     `json:"ttl_seconds"`
	FetchedAt           time.Time `json:"fetched_at"`
}

func AgentConfigPath() string { return filepath.Join(RootDir(), "agent-config.json") }

func (a *AgentConfig) IsExpired(now time.Time) bool {
	return now.After(a.FetchedAt.Add(time.Duration(a.TTLSeconds) * time.Second))
}

func LoadAgentConfig() (*AgentConfig, error) {
	b, err := os.ReadFile(AgentConfigPath())
	if err != nil {
		return nil, err
	}
	var a AgentConfig
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func SaveAgentConfig(a *AgentConfig) error {
	if err := precheckRuntime(); err != nil {
		return err
	}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return writeFileAtomically(AgentConfigPath(), b) // reuse the existing atomic-write helper used by SaveRedactionSet
}
```

(Use whatever atomic-write helper `config/redactionset.go` calls — the report describes `CreateTemp→Chmod 0600→Sync→Rename`. Match its exact function name.)

- [ ] **Step 5: Add IntervalProvider + wire the loop**

In `agent/watcher/loop.go`, add:

```go
type IntervalProvider struct {
	mu sync.RWMutex
	d  time.Duration
}

func NewIntervalProvider(d time.Duration) *IntervalProvider {
	return &IntervalProvider{d: d}
}
func (p *IntervalProvider) Current() time.Duration {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.d
}
func (p *IntervalProvider) Set(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.d = d
}
```

Change `LoopOpts` to accept `IntervalProvider *IntervalProvider` (keep `Interval time.Duration` as a fallback if `IntervalProvider` is nil, for `--once`/tests). In `Loop.Run`, replace `time.After(l.interval)` with `time.After(l.intervalProvider.Current())` (falling back to the fixed field when the provider is nil). Store the provider in `NewLoop`.

- [ ] **Step 6: Wire bootstrap + refresher in run.go**

In `runRun` (`run.go`), before building the loop:

```go
	interval := flagInterval // from --interval flag
	if cached, err := config.LoadAgentConfig(); err == nil && cached.PollIntervalSeconds > 0 {
		interval = time.Duration(cached.PollIntervalSeconds) * time.Second
	}
	intervalProvider := watcher.NewIntervalProvider(interval)
```

Add a refresher goroutine (mirror the redaction-set refresher at `run.go:168-210`, but on a fixed 1-hour ticker):

```go
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		// initial fetch on startup
		refreshAgentConfig(ctx, client, token, intervalProvider, logger)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refreshAgentConfig(ctx, client, token, intervalProvider, logger)
			}
		}
	}()
```

Where `refreshAgentConfig` fetches, clamps to [30s,1800s], calls `intervalProvider.Set(...)`, and `config.SaveAgentConfig(...)`; on fetch error it logs and leaves the current value (cache/flag/default fallback). Pass `IntervalProvider: intervalProvider` into `LoopOpts`.

- [ ] **Step 7: Loop interval test + run**

`agent/watcher/loop_interval_test.go`: construct an `IntervalProvider`, assert `Current()`; `Set()` a new value; assert it changed. (A full loop-timing test is flaky; unit-test the provider + assert `NewLoop` reads it.)

Run: `cd agent && go test ./internal/api/ ./internal/config/ ./watcher/`
Expected: PASS. Then `cd agent && ./scripts/coverage.sh` to confirm the 80% gate still holds.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/api/agentconfig.go agent/internal/config/agentconfig.go agent/internal/cli/run.go agent/watcher/loop.go agent/internal/api/agentconfig_test.go agent/watcher/loop_interval_test.go
git commit -m "feat(agent): hourly agent-config fetch drives dynamic poll interval"
```

---

### Task 8: Go agent — launchd `install-service` / `uninstall-service`

Register the daemon as a launchd LaunchAgent so it runs resident and restarts on login.

**Files:**
- Create: `agent/internal/cli/service_darwin.go` (install/uninstall, darwin build tag)
- Create: `agent/internal/cli/service_other.go` (non-darwin stubs returning `ExitNotImplemented`)
- Create: `agent/internal/service/plist.go` (plist template + path helpers, testable, no build tag)
- Modify: `agent/internal/cli/root.go` (register both commands)
- Test: `agent/internal/service/plist_test.go`

**Interfaces:**
- Consumes: `config.RootDir()`, `config.LogPath()`, `os.Executable()`.
- Produces: `service.LaunchAgentPath() string` (`~/Library/LaunchAgents/tw.caliber.agent.plist`), `service.RenderPlist(execPath, logPath string) (string, error)`, cobra commands `install-service` / `uninstall-service`.

- [ ] **Step 1: Write the failing plist test**

`agent/internal/service/plist_test.go`:

```go
package service

import (
	"strings"
	"testing"
)

func TestRenderPlist(t *testing.T) {
	out, err := RenderPlist("/usr/local/bin/caliber-agent", "/home/u/.caliber-agent/agent.log")
	if err != nil {
		t.Fatalf("RenderPlist: %v", err)
	}
	for _, want := range []string{
		"<key>Label</key>", "<string>tw.caliber.agent</string>",
		"<string>/usr/local/bin/caliber-agent</string>", "<string>run</string>",
		"<key>KeepAlive</key>", "<key>RunAtLoad</key>",
		"/home/u/.caliber-agent/agent.log",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("plist missing %q", want)
		}
	}
	// XML-escape safety: a path with & must be escaped
	esc, _ := RenderPlist("/a&b/caliber-agent", "/l.log")
	if strings.Contains(esc, "/a&b/") || !strings.Contains(esc, "/a&amp;b/") {
		t.Error("exec path not XML-escaped")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/service/ -run TestRenderPlist`
Expected: FAIL — package/func undefined.

- [ ] **Step 3: Implement the plist renderer**

`agent/internal/service/plist.go`:

```go
package service

import (
	"bytes"
	"os"
	"path/filepath"
	"text/template"
)

const LaunchAgentLabel = "tw.caliber.agent"

func LaunchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist")
}

var plistTmpl = template.Must(template.New("plist").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{{.Label}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{.Exec}}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{{.Log}}</string>
  <key>StandardErrorPath</key>
  <string>{{.Log}}</string>
</dict>
</plist>
`))

func RenderPlist(execPath, logPath string) (string, error) {
	var buf bytes.Buffer
	// text/template does NOT XML-escape; use html/template semantics by pre-escaping.
	err := plistTmpl.Execute(&buf, map[string]string{
		"Label": LaunchAgentLabel,
		"Exec":  xmlEscape(execPath),
		"Log":   xmlEscape(logPath),
	})
	return buf.String(), err
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	_ = xmlEscapeTo(&b, s)
	return b.String()
}
```

Implement `xmlEscapeTo` with `encoding/xml`'s `xml.EscapeText(&b, []byte(s))`. (Simpler: `import "encoding/xml"` and `xml.EscapeText`.)

- [ ] **Step 4: Implement the darwin service commands**

`agent/internal/cli/service_darwin.go` (build tag `//go:build darwin`):

```go
//go:build darwin

package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/service"
)

func newInstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install-service",
		Short: "Install the launchd LaunchAgent (macOS resident mode)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			exe, _ = filepath.EvalSymlinks(exe)
			plist, err := service.RenderPlist(exe, config.LogPath())
			if err != nil {
				return err
			}
			path := service.LaunchAgentPath()
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
				return err
			}
			uid := fmt.Sprintf("gui/%d", os.Getuid())
			// bootout is best-effort (may not be loaded yet); bootstrap loads it.
			_ = exec.Command("launchctl", "bootout", uid, path).Run()
			if out, err := exec.Command("launchctl", "bootstrap", uid, path).CombinedOutput(); err != nil {
				return fmt.Errorf("launchctl bootstrap: %v: %s", err, out)
			}
			fmt.Fprintln(cmd.OutOrStdout(), "caliber-agent installed as a launchd service")
			return nil
		},
	}
}

func newUninstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall-service",
		Short: "Remove the launchd LaunchAgent",
		RunE: func(cmd *cobra.Command, _ []string) error {
			path := service.LaunchAgentPath()
			uid := fmt.Sprintf("gui/%d", os.Getuid())
			_ = exec.Command("launchctl", "bootout", uid, path).Run()
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "caliber-agent launchd service removed")
			return nil
		},
	}
}
```

`agent/internal/cli/service_other.go` (build tag `//go:build !darwin`): both commands return `ExitNotImplemented(cmd)` with a message pointing at `caliber-agent run` for foreground use.

- [ ] **Step 5: Register in root.go**

In `agent/internal/cli/root.go` (`:37-45`), add:

```go
	cmd.AddCommand(newInstallServiceCmd())
	cmd.AddCommand(newUninstallServiceCmd())
```

(These resolve to the darwin or the stub implementation via build tags.)

- [ ] **Step 6: Run to verify it passes**

Run: `cd agent && go test ./internal/service/ && go build ./...`
Expected: PASS + clean build (both build tags compile).

- [ ] **Step 7: Commit**

```bash
git add agent/internal/service/ agent/internal/cli/service_darwin.go agent/internal/cli/service_other.go agent/internal/cli/root.go
git commit -m "feat(agent): launchd install-service/uninstall-service (macOS resident mode)"
```

---

### Task 9: release — add linux targets to `agent-release.yml`

macOS is the v1 resident platform, but Linux members run the same binary in foreground fallback, so the release must ship linux tarballs too. The existing workflow (`agent/v*` tag → darwin arm64/amd64 tarball + `.sha256` sidecar) only needs its build matrix extended.

**Files:**
- Modify: `.github/workflows/agent-release.yml`

**Interfaces:**
- Produces release assets named `caliber-agent-<SAFE_TAG>-<goos>-<goarch>.tar.gz` (+ `.sha256`) for `{darwin,linux} × {arm64,amd64}`, where `SAFE_TAG` = the tag with `/`→`_` (e.g. `agent_v0.2.0`). The TS CLI (Task 11) builds download URLs from this exact naming.

- [ ] **Step 1: Extend the build matrix**

In `.github/workflows/agent-release.yml`, add linux entries to `strategy.matrix.include`:

```yaml
      matrix:
        include:
          - { goos: darwin, goarch: arm64 }
          - { goos: darwin, goarch: amd64 }
          - { goos: linux,  goarch: arm64 }
          - { goos: linux,  goarch: amd64 }
```

Cross-compiling pure-Go from `macos-14` works (no cgo in the agent — verify `CGO_ENABLED=0` is safe; add `CGO_ENABLED: 0` to the Build step `env` to be explicit). Everything else (build/tar/sha256/release steps) is target-agnostic and unchanged.

- [ ] **Step 2: Verify the workflow lints**

Run: `ls .github/workflows/agent-release.yml` and eyeball the YAML (no CI runner available locally). Confirm `CGO_ENABLED: 0` is present in the Build `env`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-release.yml
git commit -m "ci(agent): build linux arm64/amd64 tarballs in agent-release"
```

Note: cutting an actual `agent/v0.2.0` tag (which triggers this workflow and publishes the binaries the CLI downloads) happens during rollout (Task 15), not here.

---

### Task 10: TS CLI — auth/agent state persistence in a new config module

`caliber login`/`logout`/`agent` need to record the server URL, the pinned agent version, and the installed binary path — none of which fit the existing `~/.caliber.json` analyzer config. Add a separate `~/.caliber/cli.json` store (no secrets — the `cda_*` key lives in the agent's keychain).

**Files:**
- Create: `src/login/state.ts`
- Test: `tests/login-state.test.ts`

**Interfaces:**
- Produces: `type CliState = { serverUrl: string; agentVersion: string; binaryPath: string }`; `loadCliState(): CliState | null`; `saveCliState(s: CliState): void`; `clearCliState(): void`; `cliStateDir(): string` (`~/.caliber`), `cliStatePath(): string` (`~/.caliber/cli.json`), `agentBinaryPath(): string` (`~/.caliber/bin/caliber-agent`).

- [ ] **Step 1: Write the failing test**

`tests/login-state.test.ts` (unit test importing the source directly — like the `period.js` unit tests; uses a temp HOME):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let orig: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "caliber-cli-"));
  orig = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  process.env.HOME = orig;
  rmSync(tmp, { recursive: true, force: true });
});

describe("cli state", () => {
  it("returns null when unset", async () => {
    const { loadCliState } = await import("../src/login/state.js");
    expect(loadCliState()).toBeNull();
  });
  it("round-trips save/load and clears", async () => {
    const { loadCliState, saveCliState, clearCliState } = await import("../src/login/state.js");
    saveCliState({ serverUrl: "https://caliber.miilink.net", agentVersion: "agent/v0.2.0", binaryPath: join(tmp, ".caliber/bin/caliber-agent") });
    expect(loadCliState()?.serverUrl).toBe("https://caliber.miilink.net");
    clearCliState();
    expect(loadCliState()).toBeNull();
  });
});
```

Note: `import("../src/login/state.js")` is dynamic so each test picks up the reset `HOME`. `state.ts` must read `homedir()` (or `process.env.HOME`) lazily inside each function, not at module load.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/login-state.test.ts --config vitest.config.ts` — note this needs the root vitest `include` to cover `tests/login-state.test.ts` (it does: `tests/**/*.test.ts`), but these are NOT subprocess tests, so no build needed. If the root config forces a build via `pretest`, run `pnpm exec vitest run tests/login-state.test.ts` directly.
Expected: FAIL — cannot resolve `../src/login/state.js`.

- [ ] **Step 3: Implement the state module**

`src/login/state.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliState {
  readonly serverUrl: string;
  readonly agentVersion: string;
  readonly binaryPath: string;
}

export function cliStateDir(): string {
  return join(homedir(), ".caliber");
}
export function cliStatePath(): string {
  return join(cliStateDir(), "cli.json");
}
export function agentBinaryPath(): string {
  return join(cliStateDir(), "bin", "caliber-agent");
}

export function loadCliState(): CliState | null {
  const path = cliStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CliState>;
    if (!raw.serverUrl || !raw.agentVersion || !raw.binaryPath) return null;
    return { serverUrl: raw.serverUrl, agentVersion: raw.agentVersion, binaryPath: raw.binaryPath };
  } catch {
    return null;
  }
}

export function saveCliState(state: CliState): void {
  mkdirSync(cliStateDir(), { recursive: true });
  writeFileSync(cliStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearCliState(): void {
  rmSync(cliStatePath(), { force: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run tests/login-state.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/login/state.ts tests/login-state.test.ts
git commit -m "feat(cli): add ~/.caliber/cli.json state store for login"
```

---

### Task 11: TS CLI — device-code client + binary downloader (pure functions)

The network + download logic, unit-tested against a stubbed `fetch`, before wiring into commander.

**Files:**
- Create: `src/login/device-auth.ts` (start/poll against the API)
- Create: `src/login/download.ts` (resolve platform asset, download, sha256-verify, extract)
- Test: `tests/device-auth.test.ts`, `tests/download.test.ts`

**Interfaces:**
- Consumes: global `fetch` (Node ≥20), `node:crypto`, `node:fs`, `node:zlib`/`tar` (see Step 5 note).
- Produces:
  - `startDeviceAuth(serverUrl, meta): Promise<DeviceAuthStart>` where `DeviceAuthStart = { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in }`.
  - `pollDeviceAuth(serverUrl, deviceCode): Promise<{ status: "pending" | "denied" | "expired"; enrollmentToken?: string }>`.
  - `pollUntilApproved(serverUrl, start, opts): Promise<string>` (returns enrollment token; respects `interval`, throws on expiry/denial; `opts.sleep` injectable for tests).
  - `assetName(agentTag, platform, arch): string`, `assetUrl(repo, agentTag, name): string`, `downloadAndVerify(url, sha256Url, destTar): Promise<void>`, `extractBinary(destTar, destBin): Promise<void>`, `resolvePlatform(): { platform: "darwin"|"linux"; arch: "arm64"|"amd64" }`.

- [ ] **Step 1: Write the failing device-auth test**

`tests/device-auth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { startDeviceAuth, pollUntilApproved } from "../src/login/device-auth.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { status: r.status, ok: r.status < 400, json: async () => r.body } as Response;
  }));
}

describe("startDeviceAuth", () => {
  it("posts metadata and returns the flow", async () => {
    stubFetchSequence([{ status: 201, body: { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://x/device", verification_uri_complete: "https://x/device?code=BCDF-GHJK", interval: 5, expires_in: 900 } }]);
    const start = await startDeviceAuth("https://x", { hostname: "h", os: "darwin", agentVersion: "0.2.0", cliVersion: "0.2.0" });
    expect(start.user_code).toBe("BCDF-GHJK");
  });
});

describe("pollUntilApproved", () => {
  const start = { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "u", verification_uri_complete: "u", interval: 0, expires_in: 900 };
  it("resolves the enrollment token after pending rounds", async () => {
    stubFetchSequence([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { enrollment_token: "tok_xyz" } },
    ]);
    const token = await pollUntilApproved("https://x", start, { sleep: async () => {} });
    expect(token).toBe("tok_xyz");
  });
  it("throws on access_denied", async () => {
    stubFetchSequence([{ status: 400, body: { error: "access_denied" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/denied/i);
  });
  it("throws on expired_token", async () => {
    stubFetchSequence([{ status: 400, body: { error: "expired_token" } }]);
    await expect(pollUntilApproved("https://x", start, { sleep: async () => {} })).rejects.toThrow(/expired/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/device-auth.test.ts`
Expected: FAIL — cannot resolve `../src/login/device-auth.js`.

- [ ] **Step 3: Implement device-auth.ts**

`src/login/device-auth.ts`:

```ts
export interface DeviceAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export interface DeviceMeta {
  hostname: string;
  os: string;
  agentVersion: string;
  cliVersion: string;
}

function base(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "");
}

export async function startDeviceAuth(serverUrl: string, meta: DeviceMeta): Promise<DeviceAuthStart> {
  const res = await fetch(`${base(serverUrl)}/v1/device-auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (res.status !== 201) {
    throw new Error(`device-auth start failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DeviceAuthStart;
}

export interface PollOpts {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollUntilApproved(
  serverUrl: string,
  start: DeviceAuthStart,
  opts: PollOpts = {},
): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + start.expires_in * 1000;
  const intervalMs = Math.max(0, start.interval * 1000);
  for (;;) {
    const res = await fetch(`${base(serverUrl)}/v1/device-auth/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    const body = (await res.json()) as { error?: string; enrollment_token?: string };
    if (res.status === 200 && body.enrollment_token) return body.enrollment_token;
    if (body.error === "access_denied") throw new Error("Authorization was denied on the dashboard.");
    if (body.error === "expired_token") throw new Error("The login request expired. Run `caliber login` again.");
    // authorization_pending / slow_down → wait and retry
    if (now() >= deadline) throw new Error("The login request expired. Run `caliber login` again.");
    await sleep(intervalMs);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run tests/device-auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write + implement download.ts**

`tests/download.test.ts` covers the pure helpers (`assetName`, `assetUrl`, `resolvePlatform` mapping, and `verifySha256` against a known digest). Implement `src/login/download.ts`:

```ts
import { createHash } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

export function resolvePlatform(): { platform: "darwin" | "linux"; arch: "arm64" | "amd64" } {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { platform, arch };
}

// SAFE_TAG replaces "/" with "_": agent/v0.2.0 -> agent_v0.2.0
export function assetName(agentTag: string, platform: string, arch: string): string {
  const safe = agentTag.replace(/\//g, "_");
  return `caliber-agent-${safe}-${platform}-${arch}.tar.gz`;
}

export function assetUrl(repo: string, agentTag: string, name: string): string {
  // repo e.g. "hanfour/caliber"; release tag keeps the slash: .../download/agent/v0.2.0/<name>
  return `https://github.com/${repo}/releases/download/${agentTag}/${name}`;
}

export function verifySha256(filePath: string, expectedHex: string): boolean {
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return hash.toLowerCase() === expectedHex.trim().toLowerCase().split(/\s+/)[0];
}

export async function downloadTo(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

export async function fetchSha256(sha256Url: string): Promise<string> {
  const res = await fetch(sha256Url);
  if (!res.ok) throw new Error(`sha256 fetch failed (HTTP ${res.status})`);
  return (await res.text()).trim().split(/\s+/)[0];
}

// Extract the single `caliber-agent` binary from the tarball via system tar
// (available on macOS + Linux; avoids a tar npm dependency).
export function extractBinary(tarPath: string, destDir: string): void {
  const r = spawnSync("tar", ["-xzf", tarPath, "-C", destDir, "caliber-agent"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("failed to extract caliber-agent from tarball");
}
```

The `download.test.ts` should test only the pure functions (`assetName`, `assetUrl`, `resolvePlatform` via stubbing `process.platform`/`process.arch` with `Object.defineProperty`, and `verifySha256` by writing a temp file with known content and its precomputed digest). Network functions (`downloadTo`/`fetchSha256`) are exercised in the E2E task, not unit-mocked.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec vitest run tests/device-auth.test.ts tests/download.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/login/device-auth.ts src/login/download.ts tests/device-auth.test.ts tests/download.test.ts
git commit -m "feat(cli): device-auth client + agent binary downloader with sha256 verify"
```

---

### Task 12: TS CLI — `login` / `logout` / `agent` commands wired into commander

Orchestrate the whole onboarding: device-auth → download agent → non-interactive enroll → install service.

**Files:**
- Create: `src/login/commands.ts` (the three command handlers)
- Modify: `src/cli.ts` (register the commands)
- Modify: `src/config.ts` (nothing — auth state is separate; but add an `AGENT_TAG` constant somewhere central: create `src/login/constants.ts`)
- Create: `src/login/constants.ts`
- Test: `tests/cli-login.test.ts` (subprocess: assert `caliber login --help` / `caliber agent --help` register and error cleanly without a server)

**Interfaces:**
- Consumes: everything from Tasks 10–11; `child_process.spawnSync` to invoke the Go agent for enroll/install/status/pause/resume/uninstall.
- Produces: `caliber login [--server <url>]`, `caliber logout`, `caliber agent <status|pause|resume>`. Constant `AGENT_TAG = "agent/v0.2.0"` and `AGENT_REPO = "hanfour/caliber"` in `constants.ts` (the pinned agent version the CLI downloads — bumped per CLI release).

- [ ] **Step 1: Write the failing subprocess test**

`tests/cli-login.test.ts` (mirror `tests/cli.test.ts` — runs `dist/cli.js`):

```ts
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");
const run = (args: string) =>
  execSync(`node "${CLI}" ${args} 2>&1`, { encoding: "utf-8", timeout: 30000, env: { ...process.env, NO_COLOR: "1" } });

describe("caliber login/agent CLI surface", () => {
  it("login --help lists the --server flag", () => {
    const out = run("login --help");
    expect(out).toMatch(/--server/);
  });
  it("agent --help lists subcommands", () => {
    const out = run("agent --help");
    expect(out).toMatch(/status/);
    expect(out).toMatch(/pause/);
    expect(out).toMatch(/resume/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && pnpm exec vitest run tests/cli-login.test.ts`
Expected: FAIL — commands not registered (`login --help` errors / unknown command).

- [ ] **Step 3: Add constants**

`src/login/constants.ts`:

```ts
// The Go agent release the CLI downloads. Bump this in lockstep with a CLI
// release whenever a new agent binary must ship. Tag format matches the
// agent-release.yml trigger (`agent/v*`) and the GitHub release tag.
export const AGENT_TAG = "agent/v0.2.0";
export const AGENT_REPO = "hanfour/caliber";
export const DEFAULT_SERVER_URL = "https://caliber.miilink.net";
```

- [ ] **Step 4: Implement the command handlers**

`src/login/commands.ts`:

```ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { startDeviceAuth, pollUntilApproved } from "./device-auth.js";
import {
  assetName, assetUrl, downloadTo, fetchSha256, verifySha256, extractBinary, resolvePlatform,
} from "./download.js";
import { agentBinaryPath, cliStateDir, clearCliState, loadCliState, saveCliState } from "./state.js";
import { AGENT_REPO, AGENT_TAG, DEFAULT_SERVER_URL } from "./constants.js";

const log = (msg: string) => process.stderr.write(msg + "\n");

async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawnSync(cmd, [url], { stdio: "ignore" });
}

export async function loginCommand(opts: { server?: string }): Promise<void> {
  const serverUrl = (opts.server ?? DEFAULT_SERVER_URL).replace(/\/$/, "");
  const { platform, arch } = resolvePlatform();

  // 1. Device-code authorization
  log(chalk.dim("Requesting device authorization…"));
  const start = await startDeviceAuth(serverUrl, {
    hostname: hostname(), os: `${platform}-${arch}`, agentVersion: AGENT_TAG, cliVersion: "0.2.0",
  });
  log("");
  log(`  ${chalk.bold("Open:")} ${start.verification_uri}`);
  log(`  ${chalk.bold("Code:")} ${chalk.cyan(start.user_code)}`);
  log("");
  await openBrowser(start.verification_uri_complete);
  log(chalk.dim("Waiting for approval in the browser…"));
  const enrollmentToken = await pollUntilApproved(serverUrl, start);
  log(chalk.green("✓ Authorized"));

  // 2. Download the agent binary (skip if already the pinned version)
  const binPath = agentBinaryPath();
  const state = loadCliState();
  if (!(state?.agentVersion === AGENT_TAG && existsSync(binPath))) {
    const name = assetName(AGENT_TAG, platform, arch);
    const url = assetUrl(AGENT_REPO, AGENT_TAG, name);
    const tarPath = join(tmpdir(), name);
    log(chalk.dim(`Downloading ${name}…`));
    await downloadTo(url, tarPath);
    const expected = await fetchSha256(`${url}.sha256`);
    if (!verifySha256(tarPath, expected)) {
      throw new Error("Downloaded agent failed checksum verification — aborting.");
    }
    extractBinary(tarPath, join(cliStateDir(), "bin"));
    spawnSync("chmod", ["+x", binPath], { stdio: "ignore" });
    log(chalk.green("✓ Agent downloaded and verified"));
  }

  // 3. Non-interactive enroll (watch-all, full-body)
  const enroll = spawnSync(
    binPath,
    ["enroll", enrollmentToken, "--server", serverUrl, "--yes", "--watch-all", "--mode", "full-body"],
    { stdio: "inherit" },
  );
  if (enroll.status !== 0) throw new Error("Agent enrollment failed.");

  // 4. Install the resident service (macOS launchd; other platforms print guidance)
  if (platform === "darwin") {
    const svc = spawnSync(binPath, ["install-service"], { stdio: "inherit" });
    if (svc.status !== 0) throw new Error("Failed to install the launchd service.");
  } else {
    log(chalk.yellow("Linux: resident mode not auto-installed. Run `caliber agent run` (or add a systemd user unit) to keep it running."));
  }

  saveCliState({ serverUrl, agentVersion: AGENT_TAG, binaryPath: binPath });
  log("");
  log(chalk.green.bold("✓ caliber is now recording your Claude Code / Codex sessions."));
  log(chalk.dim(`  Backfilling the past 90 days. Dashboard: ${serverUrl}/dashboard/devices`));
  log(chalk.dim("  Pause anytime with `caliber agent pause`."));
}

export function logoutCommand(): void {
  const state = loadCliState();
  const binPath = state?.binaryPath ?? agentBinaryPath();
  if (existsSync(binPath)) {
    if (process.platform === "darwin") spawnSync(binPath, ["uninstall-service"], { stdio: "inherit" });
    spawnSync(binPath, ["uninstall"], { stdio: "inherit" });
  }
  clearCliState();
  process.stderr.write(chalk.green("✓ Logged out and stopped recording.\n"));
}

export function agentPassthrough(sub: "status" | "pause" | "resume"): void {
  const binPath = loadCliState()?.binaryPath ?? agentBinaryPath();
  if (!existsSync(binPath)) {
    process.stderr.write(chalk.red("Not logged in. Run `caliber login` first.\n"));
    process.exitCode = 1;
    return;
  }
  const r = spawnSync(binPath, [sub], { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
}
```

- [ ] **Step 5: Register in `src/cli.ts`**

Add imports near the top:

```ts
import { loginCommand, logoutCommand, agentPassthrough } from "./login/commands.js";
```

Register the commands (before `program.parse()`):

```ts
program
  .command("login")
  .description("Log in and start recording Claude Code / Codex usage on this machine")
  .option("--server <url>", "Caliber server URL")
  .action(async (opts: { server?: string }) => {
    try {
      await loginCommand(opts);
    } catch (err) {
      process.stderr.write(chalk.red((err as Error).message) + "\n");
      process.exitCode = 1;
    }
  });

program
  .command("logout")
  .description("Stop recording and remove the local agent")
  .action(() => logoutCommand());

const agentCmd = program.command("agent").description("Control the local recording agent");
for (const sub of ["status", "pause", "resume"] as const) {
  agentCmd
    .command(sub)
    .description(`${sub} the local recording agent`)
    .action(() => agentPassthrough(sub));
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm build && pnpm exec vitest run tests/cli-login.test.ts`
Expected: PASS (2 tests). Run `pnpm typecheck` (root).

- [ ] **Step 7: Commit**

```bash
git add src/login/commands.ts src/login/constants.ts src/cli.ts tests/cli-login.test.ts
git commit -m "feat(cli): login/logout/agent commands orchestrating device-auth + resident agent"
```

---

### Task 13: web — `/device` approval page (session-gated, consent copy)

A dashboard-outside, login-required page where a member enters/confirms the user code, sees the consent copy, and approves — driving `devices.deviceAuth.approve`.

**Files:**
- Create: `apps/web/src/app/device/page.tsx` (client component)
- Create: `apps/web/src/components/device/DeviceApproval.tsx`
- Modify: all 5 `apps/web/messages/*.json` (add a `deviceApproval` namespace)
- Modify: `apps/web/tests/lib/i18n/messagesParity.test.ts` (add the new keys)
- Test: `apps/web/tests/components/device/DeviceApproval.test.tsx`

**Interfaces:**
- Consumes: `trpc.me.session.useQuery`, `trpc.devices.deviceAuth.lookup.useQuery`, `trpc.devices.deviceAuth.approve.useMutation`, `trpc.devices.deviceAuth.deny.useMutation`; shadcn `Card/Button/Input/Label`; `useSearchParams` for `?code=`.
- Produces: the route `/device`.

- [ ] **Step 1: Add i18n keys to ALL 5 catalogs**

Add this `deviceApproval` namespace to `apps/web/messages/en.json` (and translate into `zh-TW`, `zh-CN`, `ja`, `ko` — for zh-TW use the copy below; for the others translate faithfully):

```json
"deviceApproval": {
  "title": "Authorize this device",
  "subtitle": "A CLI on {hostname} is requesting to record your Claude Code and Codex sessions.",
  "codeLabel": "Device code",
  "codePlaceholder": "XXXX-XXXX",
  "lookupCta": "Continue",
  "deviceInfo": "{hostname} · {os}",
  "consentHeading": "What will be recorded",
  "consentBody": "Your full Claude Code and Codex conversations on this machine (with secrets automatically redacted) will be uploaded to your organization, including the past 90 days of history. You can pause anytime with `caliber agent pause` or revoke this device from the dashboard.",
  "approve": "Authorize",
  "deny": "Deny",
  "approved": "Device authorized. Return to your terminal — it will finish setup automatically.",
  "denied": "Request denied.",
  "notFound": "That code is invalid or has expired. Run `caliber login` again.",
  "signInPrompt": "Please sign in to authorize this device.",
  "signInCta": "Sign in"
}
```

zh-TW copy:

```json
"deviceApproval": {
  "title": "授權此裝置",
  "subtitle": "{hostname} 上的 CLI 要求記錄你的 Claude Code 與 Codex 使用紀錄。",
  "codeLabel": "裝置代碼",
  "codePlaceholder": "XXXX-XXXX",
  "lookupCta": "繼續",
  "deviceInfo": "{hostname} · {os}",
  "consentHeading": "將會記錄的內容",
  "consentBody": "這台機器上完整的 Claude Code 與 Codex 對話內容（機密會自動遮罩）將上傳至你的組織，包含過去 90 天的歷史紀錄。你可隨時用 `caliber agent pause` 暫停，或從儀表板撤銷此裝置。",
  "approve": "授權",
  "deny": "拒絕",
  "approved": "裝置已授權。回到終端機，它會自動完成設定。",
  "denied": "已拒絕請求。",
  "notFound": "代碼無效或已過期。請重新執行 `caliber login`。",
  "signInPrompt": "請先登入以授權此裝置。",
  "signInCta": "登入"
}
```

- [ ] **Step 2: Extend the parity test (RED)**

In `apps/web/tests/lib/i18n/messagesParity.test.ts`, add the new leaf keys to the checked key list (follow the existing `PR*_KEYS` array pattern):

```ts
const DEVICE_APPROVAL_KEYS = [
  "deviceApproval.title", "deviceApproval.subtitle", "deviceApproval.codeLabel",
  "deviceApproval.codePlaceholder", "deviceApproval.lookupCta", "deviceApproval.deviceInfo",
  "deviceApproval.consentHeading", "deviceApproval.consentBody", "deviceApproval.approve",
  "deviceApproval.deny", "deviceApproval.approved", "deviceApproval.denied",
  "deviceApproval.notFound", "deviceApproval.signInPrompt", "deviceApproval.signInCta",
];
```

and include it in the array the test iterates over.

Run: `pnpm --filter @caliber/web exec vitest run tests/lib/i18n/messagesParity.test.ts`
Expected: PASS if all 5 catalogs have the keys; FAIL if any translation is missing (fix the missing catalog).

- [ ] **Step 3: Write the component test (RED)**

`apps/web/tests/components/device/DeviceApproval.test.tsx` — render with a mocked `trpc`, assert: signed-out shows sign-in prompt; with a looked-up flow, the consent body + Authorize button render; clicking Authorize calls the approve mutation. Follow the existing web component test setup (`apps/web/tests/setup.ts`, `@testing-library/react`). Mock `trpc` the way existing component tests do (search `apps/web/tests/components` for the mock pattern — likely `vi.mock("@/lib/trpc/client")`).

- [ ] **Step 4: Implement the page + component**

`apps/web/src/app/device/page.tsx`:

```tsx
"use client";
import { Suspense } from "react";
import { DeviceApproval } from "@/components/device/DeviceApproval";

export default function DevicePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense>
        <DeviceApproval />
      </Suspense>
    </main>
  );
}
```

`apps/web/src/components/device/DeviceApproval.tsx` — model on `api-keys/reveal/[token]/page.tsx`:
- `trpc.me.session.useQuery()`; while loading show a spinner Card; if `!session?.user` show the sign-in Card with a button that does `router.push('/sign-in?returnTo=' + encodeURIComponent(location.pathname + location.search))`.
- Read `?code=` via `useSearchParams()`; hold `userCode` state; a "Continue" step calls `trpc.devices.deviceAuth.lookup.useQuery({ userCode }, { enabled: submitted })`. On `NOT_FOUND` show `t("notFound")`.
- Once looked up, render a `Card` with `t("subtitle", { hostname })`, the `consentHeading` + `consentBody`, and two buttons: Authorize → `approve.mutate({ userCode })`, Deny → `deny.mutate({ userCode })`.
- On approve success show `t("approved")`; on deny show `t("denied")`.
- Uses `useTranslations("deviceApproval")`.

Keep rendering side-effect-free (mutations only fire on button clicks), matching the reveal-page convention.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/device/DeviceApproval.test.tsx tests/lib/i18n/messagesParity.test.ts`
Expected: PASS. Run `pnpm --filter @caliber/web typecheck` and `pnpm --filter @caliber/web lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/device apps/web/src/components/device apps/web/messages apps/web/tests/components/device apps/web/tests/lib/i18n/messagesParity.test.ts
git commit -m "feat(web): /device approval page with consent copy (device-code login)"
```

---

### Task 14: web — org agent-config card on `/dashboard/devices`

Org-admins set the poll interval; the card is hidden for non-admins.

**Files:**
- Create: `apps/web/src/components/devices/AgentConfigCard.tsx`
- Modify: `apps/web/src/app/dashboard/devices/page.tsx` (render the card)
- Modify: all 5 `apps/web/messages/*.json` (add `devices.agentConfig` keys)
- Modify: `apps/web/tests/lib/i18n/messagesParity.test.ts`
- Test: `apps/web/tests/components/devices/AgentConfigCard.test.tsx`

**Interfaces:**
- Consumes: `usePermissions`, `RequirePerm` with `{ type: "device.list_all", orgId }`, `trpc.devices.agentConfig.get/set`; the member's primary org id (from `usePermissions().perm` / `me.session` covered orgs).
- Produces: the card UI.

- [ ] **Step 1: Add i18n keys (all 5 catalogs) + parity test entry**

Add under the existing `devices` namespace in each catalog. en:

```json
"agentConfig": {
  "title": "Agent settings",
  "intervalLabel": "Upload interval (seconds)",
  "intervalHint": "How often each device uploads new activity. 30–1800s. Lower = fresher dashboards; higher = lighter.",
  "save": "Save",
  "saved": "Saved",
  "outOfRange": "Value was clamped to the allowed 30–1800s range."
}
```

zh-TW:

```json
"agentConfig": {
  "title": "Agent 設定",
  "intervalLabel": "上傳間隔（秒）",
  "intervalHint": "每台裝置上傳新活動的頻率。30–1800 秒。越低儀表板越即時，越高越省資源。",
  "save": "儲存",
  "saved": "已儲存",
  "outOfRange": "數值已被限制在允許的 30–1800 秒範圍內。"
}
```

Add the 6 leaf keys (`devices.agentConfig.*`) to `messagesParity.test.ts`.

- [ ] **Step 2: Write the component test (RED)**

`apps/web/tests/components/devices/AgentConfigCard.test.tsx`: with an org-admin perm mock + `get` returning `{ pollIntervalSeconds: 60 }`, the input shows 60; entering 5 and saving calls `set` with `{ pollIntervalSeconds: 5 }`; a non-admin perm renders nothing.

- [ ] **Step 3: Implement the card**

`apps/web/src/components/devices/AgentConfigCard.tsx` — a `Card` wrapped in `<RequirePerm action={{ type: "device.list_all", orgId }}>`; `trpc.devices.agentConfig.get.useQuery({ orgId })` seeds an `<Input type="number" min={30} max={1800}>`; Save calls `trpc.devices.agentConfig.set.useMutation` and on success invalidates the get query + `toast.success(t("saved"))`. Resolve `orgId` from `usePermissions()` (first covered org — the same single-org assumption the rest of the member UI uses; if the user has no org, render nothing).

- [ ] **Step 4: Render on the devices page**

In `apps/web/src/app/dashboard/devices/page.tsx`, add `<AgentConfigCard />` below `<DeviceList />` inside the `space-y-6` container.

- [ ] **Step 5: Run tests + checks**

Run: `pnpm --filter @caliber/web exec vitest run tests/components/devices/AgentConfigCard.test.tsx tests/lib/i18n/messagesParity.test.ts`
Expected: PASS. Run `pnpm --filter @caliber/web typecheck && pnpm --filter @caliber/web lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/AgentConfigCard.tsx apps/web/src/app/dashboard/devices/page.tsx apps/web/messages apps/web/tests/components/devices/AgentConfigCard.test.tsx apps/web/tests/lib/i18n/messagesParity.test.ts
git commit -m "feat(web): org agent poll-interval settings card on /dashboard/devices"
```

---

### Task 15: E2E smoke + rollout

Prove the full pipeline end-to-end, then cut the agent release and verify on the VPS.

**Files:**
- Create: `apps/api/tests/e2e/deviceLogin.e2e.test.ts` (or a scripts/ harness if the repo separates e2e)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the scripted E2E (no real browser)**

`apps/api/tests/e2e/deviceLogin.e2e.test.ts` — start the api on a testcontainer DB + a real-or-mock Redis, then:
1. `POST /v1/device-auth/start` → capture `device_code` + `user_code`.
2. Simulate the web approval by calling `devices.deviceAuth.approve` through a tRPC caller for a seeded member (bypasses the browser).
3. `POST /v1/device-auth/poll` → assert it returns an `enrollment_token`.
4. `POST /v1/devices/enroll` with that token → assert `201` + a `cda_*` key.
5. `POST /v1/ingest` with a fixture transcript body using the `cda_*` key → assert `2xx`.
6. Query `client_sessions` + `client_events` → assert the fixture rows landed.
7. `GET /v1/agent-config` with the `cda_*` key → assert `{ poll_interval_seconds: 60 }`.

This exercises Tasks 1–4 as one flow. Run: `pnpm --filter @caliber/api exec vitest run tests/e2e/deviceLogin.e2e.test.ts --config vitest.integration.config.ts`
Expected: PASS.

- [ ] **Step 2: Full workspace verification**

Run:
```bash
pnpm turbo run typecheck lint
pnpm turbo run test
( cd agent && ./scripts/coverage.sh )
pnpm build && pnpm exec vitest run   # root CLI subprocess tests
```
Expected: all green. Fix anything red before proceeding.

- [ ] **Step 3: Commit the E2E**

```bash
git add apps/api/tests/e2e/deviceLogin.e2e.test.ts
git commit -m "test(api): end-to-end device-login → ingest smoke"
```

- [ ] **Step 4: Cut the agent release (publishes the binary the CLI downloads)**

```bash
gh auth switch --user hanfour && gh auth setup-git
git tag agent/v0.2.0
git push origin agent/v0.2.0   # triggers agent-release.yml → darwin+linux tarballs + .sha256
```
Verify the release assets exist: `gh release view agent/v0.2.0 --repo hanfour/caliber`. The asset names must match `assetName()` (Task 11): `caliber-agent-agent_v0.2.0-{darwin,linux}-{arm64,amd64}.tar.gz`. If they differ, fix `AGENT_TAG`/`assetName` before publishing the CLI.

- [ ] **Step 5: Publish the CLI + deploy the server**

- Bump root `package.json` version, `src/cli.ts` `.version(...)`, and `src/login/constants.ts` `AGENT_TAG` if needed to `agent/v0.2.0`; `npm publish` (operator runs this — publishing is guarded).
- Deploy the api/web images to the VPS running migration 0024 (`docs/superpowers/specs/2026-07-03-...` §7). Set `ENABLE_ANTHROPIC_OAUTH` unaffected; ensure `NEXTAUTH_URL=https://caliber.miilink.net` so `verification_uri` resolves correctly.

- [ ] **Step 6: Live smoke on one machine**

On h4 (or mac-mini): `npm i -g @hanfour.huang/caliber@latest && caliber login`, approve in the browser, confirm: launchd job loaded (`launchctl list | grep caliber`), a device appears on `/dashboard/devices`, and within a couple of minutes `client_events` rows accrue for a real Claude/Codex session. Then `caliber agent pause` / `resume` / `caliber logout` each behave. Record results; only then roll out to the 11 members.

- [ ] **Step 7: Final commit / notes**

Capture any deployment deltas (env, disk sizing observed) in the spec's §7 and commit doc updates.

---

## Self-Review Notes

- **Spec §2 (device-code flow):** Tasks 1 (start/poll REST) + 2 (approve/deny tRPC) + 13 (/device page). ✔
- **Spec §3 (agent-config push):** Tasks 3 (column) + 4 (GET + setter) + 7 (agent fetch) + 14 (dashboard card). ✔
- **Spec §4 (TS CLI entry point):** Tasks 10 (state) + 11 (device-auth/download) + 12 (commands). ✔
- **Spec §5 (Go agent additions):** Tasks 5 (non-interactive enroll/watch-all) + 6 (90-day backfill) + 7 (hourly config) + 8 (launchd) + 9 (linux release). ✔
- **Spec §6 (consent/full-body):** enroll `--mode full-body` (Task 5/12), consent copy (Task 13). ✔
- **Spec §7 (ops/disk):** Task 15 Step 5–6. ✔
- **Spec §8 (testing):** each task is TDD; Task 15 is the integration/E2E. ✔
- **Type consistency:** `hashDeviceCode/flowKey/userCodeKey/normalizeUserCode/USER_CODE_RE/deviceAuthFlowSchema/DeviceAuthFlow` defined in Task 1, imported in Tasks 2/4. `assetName/assetUrl` signatures shared Task 11 ↔ Task 12. `AgentConfigResponse` / `poll_interval_seconds` consistent Task 4 (server) ↔ Task 7 (agent). `agent_poll_interval_seconds` column (Task 3) ↔ `organizations.agentPollIntervalSeconds` (Tasks 4). `AGENT_TAG` naming ↔ `agent-release.yml` SAFE_TAG (Tasks 9/11/12/15). ✔
- **Open verification for the implementer:** confirm `callerFor` accepts a `redis` override (Task 2 Step 5) and how org-admin perms are seeded in existing tRPC tests (Task 4 Step 5); confirm the exact atomic-write + error-parse helper names in `config/redactionset.go` / `api/redactionset.go` to copy verbatim (Tasks 7). These are noted inline where they occur.
