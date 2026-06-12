# api_key Upstream Credential Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a dead/rejected `api_key` upstream credential (N counted 401s since last 2xx/rotation), degrade it recoverably so the scheduler skips it, auto-recover on success or rotation, and surface it for rotation — fixing the latent un-recoverable `status='error'` bug along the way.

**Architecture:** Centralized in the failover loop (success → `clearAuthFailure`; classifier `auth_invalid` → `recordAuthFailure` instead of the un-recoverable `status='error'`). Redis consecutive-failure counter (zero migration); degrade sets only `tempUnschedulableUntil`/`reason`/`errorMessage` so the existing temp-predicate auto-re-admits after backoff. Surfaced via a `credential_invalid` badge + an amber rotate banner. Rotation clears the state.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, Vitest, drizzle-orm, ioredis, prom-client, tRPC, Next.js, next-intl.

**Spec:** `docs/superpowers/specs/2026-06-11-api-key-credential-health-design.md`

---

## File Structure

**New:**
- `packages/gateway-core/src/redis/authKeys.ts` — pure `authFailKey`/`authGraceKey` suffix builders (shared by gateway + api).
- `apps/gateway/src/runtime/upstreamAuthHealth.ts` — `recordAuthFailure` / `clearAuthFailure` (best-effort, never throw).

**Modified:**
- `packages/gateway-core/package.json` — `./redis` subpath export.
- `packages/gateway-core/src/stateMachine/classifier.ts` — drop `status='error'` from the 401/403 branch.
- `packages/config/src/env.ts` + `docker/docker-compose.yml` + `docker/.env.example` — 3 knobs.
- `apps/gateway/src/plugins/metrics.ts` — 2 counters.
- `apps/gateway/src/redis/keys.ts` — re-export the two helpers.
- `apps/gateway/src/runtime/failoverLoop.ts` — `RunFailoverInput.authHealth`, success + `auth_invalid` hooks.
- `apps/gateway/src/runtime/buildFailoverInput.ts` — assemble `authHealth` from `req.server`.
- `apps/gateway/src/routes/messages.ts` — anthropic non-stream: drop the 4xx-return.
- `apps/api/src/trpc/routers/accounts.ts` — `rotate` + `rotateOwn` health reset + grace key.
- `apps/web/src/components/accounts/status.tsx` — `credential_invalid`.
- `apps/web/src/components/accounts/AccountList.tsx` — banner + rotate CTA.
- `apps/web/src/components/status/CredentialHealthSection.tsx` — CTA.
- `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json` — strings.

**Phasing (each phase = working, testable software):**
- Phase 1 — pure foundations (gateway-core): Tasks 1–2.
- Phase 2 — config + metrics: Tasks 3–4.
- Phase 3 — the health helper: Task 5.
- Phase 4 — loop wiring + route alignment: Tasks 6–8.
- Phase 5 — api rotate reset: Task 9.
- Phase 6 — web surfacing: Tasks 10–13.
- Phase 7 — integration + green: Tasks 14–15.

---
## Phase 1 — Pure foundations (gateway-core)

### Task 1: Shared Redis key builders (`authFailKey` / `authGraceKey`)

**Files:**
- Create: `packages/gateway-core/src/redis/authKeys.ts`
- Create: `packages/gateway-core/src/redis/index.ts`
- Test: `packages/gateway-core/tests/redis/authKeys.test.ts`
- Modify: `packages/gateway-core/package.json` (add `./redis` subpath export, mirroring the existing `./oauth` / `./models` entries)
- Modify: `apps/gateway/src/redis/keys.ts` (re-export onto the `keys` object)

- [ ] **Step 1: Write the failing test**
```typescript
// packages/gateway-core/tests/redis/authKeys.test.ts
import { describe, it, expect } from "vitest";
import { authFailKey, authGraceKey } from "../../src/redis/authKeys.js";

describe("auth health redis keys", () => {
  it("authFailKey is a bare suffix (client prepends caliber:gw:)", () => {
    expect(authFailKey("acc-1")).toBe("authfail:acc-1");
  });
  it("authGraceKey is a bare suffix", () => {
    expect(authGraceKey("acc-1")).toBe("authgrace:acc-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/gateway-core && pnpm vitest run tests/redis/authKeys.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**
```typescript
// packages/gateway-core/src/redis/authKeys.ts
// Pure suffix builders for the api_key credential-health counters. Both the
// gateway and the api Redis clients prepend `caliber:gw:`, so these return
// the suffix only. Lives in gateway-core because apps/api depends on
// @caliber/gateway-core (not on apps/gateway).
export const authFailKey = (accountId: string): string => `authfail:${accountId}`;
export const authGraceKey = (accountId: string): string => `authgrace:${accountId}`;
```
```typescript
// packages/gateway-core/src/redis/index.ts
export { authFailKey, authGraceKey } from "./authKeys.js";
```

- [ ] **Step 4: Add the `./redis` subpath** to `packages/gateway-core/package.json` `"exports"`, mirroring the existing `./oauth` entry exactly (same `types`/`import`/`default` shape, pointing at `./dist/redis/index.js` / `.d.ts`).

- [ ] **Step 5: Re-export on the gateway `keys` object** — in `apps/gateway/src/redis/keys.ts`, import and add two entries so existing gateway call-sites can use `keys.authFail(...)`:
```typescript
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";
// ...inside the `keys` object literal, add:
  authFail: authFailKey,
  authGrace: authGraceKey,
```

- [ ] **Step 6: Build + test** — `cd packages/gateway-core && pnpm build && pnpm typecheck && pnpm vitest run tests/redis/authKeys.test.ts` → PASS. Then `cd ../../apps/gateway && pnpm typecheck` → clean.

- [ ] **Step 7: Commit**
```bash
git add packages/gateway-core/src/redis packages/gateway-core/tests/redis packages/gateway-core/package.json apps/gateway/src/redis/keys.ts
git commit -m "feat(core): shared authFailKey/authGraceKey redis suffix builders"
```

### Task 2: Classifier — drop the un-recoverable `status='error'` on 401/403

**Files:**
- Modify: `packages/gateway-core/src/stateMachine/classifier.ts:18-23`
- Test: `packages/gateway-core/tests/stateMachine/classifier.test.ts` (extend existing if present, else create)

> Rationale (spec §Classifier reconciliation): the loop now owns auth health via `recordAuthFailure`. The classifier must NOT set `status='error'` (single-strike, never auto-resets → permanent disable). 401/403 still classify as `switch_account`/`auth_invalid` so failover proceeds.

- [ ] **Step 1: Write the failing test**
```typescript
import { describe, it, expect } from "vitest";
import { classifyUpstreamError } from "../../src/stateMachine/classifier.js";

describe("classifier 401/403 (auth_invalid, no state mutation)", () => {
  it("401 → switch_account, auth_invalid, and NO stateUpdate", () => {
    const a = classifyUpstreamError({ status: 401, message: "invalid x-api-key" });
    expect(a.kind).toBe("switch_account");
    expect(a.reason).toBe("auth_invalid");
    expect("stateUpdate" in a ? a.stateUpdate : undefined).toBeUndefined();
  });
  it("403 → switch_account, auth_invalid, and NO stateUpdate", () => {
    const a = classifyUpstreamError({ status: 403, message: "forbidden" });
    expect(a.kind).toBe("switch_account");
    expect("stateUpdate" in a ? a.stateUpdate : undefined).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/gateway-core && pnpm vitest run tests/stateMachine/classifier.test.ts` → FAIL (current code returns `stateUpdate: { status: 'error', ... }`).

- [ ] **Step 3: Implement** — change the 401/403 branch (classifier.ts:18-23) to drop `stateUpdate`:
```typescript
  if (status === 401 || status === 403) {
    return {
      kind: 'switch_account',
      reason: 'auth_invalid',
    }
  }
```
(If `FailoverAction`'s `switch_account` variant requires `stateUpdate`, make it optional in `packages/gateway-core/src/stateMachine/types.ts` — `stateUpdate?: AccountStateUpdate`. Verify the other `switch_account` returns (429/529/5xx) still compile.)

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run tests/stateMachine/ && pnpm typecheck` → PASS/clean. Re-run the FULL gateway-core suite (`pnpm vitest run`) — fix any test that asserted the old `status='error'`.

- [ ] **Step 5: Commit**
```bash
git add packages/gateway-core/src/stateMachine packages/gateway-core/tests/stateMachine
git commit -m "fix(core): classifier 401/403 no longer sets un-recoverable status=error (auth health moves to the loop)"
```

---
## Phase 2 — Config + metrics

### Task 3: Env knobs (3) + compose wiring

**Files:**
- Modify: `packages/config/src/env.ts` (near `GATEWAY_OAUTH_MAX_FAIL` ~line 180)
- Test: `packages/config/tests/env.test.ts`
- Modify: `docker/docker-compose.yml` (x-app-env anchor) + `docker/.env.example`

- [ ] **Step 1: Write a failing test** (mirror the file's existing per-knob style + `minimalGatewayEnv` helper)
```typescript
it("upstream-auth health knobs default 3 / 3600 / 120", () => {
  const env = parseServerEnv({ ...minimalGatewayEnv });
  expect(env.GATEWAY_UPSTREAM_AUTH_MAX_FAIL).toBe(3);
  expect(env.GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC).toBe(3600);
  expect(env.GATEWAY_UPSTREAM_AUTH_GRACE_SEC).toBe(120);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/config && pnpm vitest run tests/env.test.ts` → FAIL (keys undefined).

- [ ] **Step 3: Add to the schema** (next to the other `GATEWAY_OAUTH_*` entries, mirroring their `emptyAsUndefined`/`z.coerce.number` pattern)
```typescript
    GATEWAY_UPSTREAM_AUTH_MAX_FAIL: emptyAsUndefined(
      z.coerce.number().int().min(1).default(3),
    ),
    GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC: emptyAsUndefined(
      z.coerce.number().int().min(1).default(3600),
    ),
    GATEWAY_UPSTREAM_AUTH_GRACE_SEC: emptyAsUndefined(
      z.coerce.number().int().min(1).default(120),
    ),
```

- [ ] **Step 4: Run to verify it passes + full suite** — `cd packages/config && pnpm vitest run && pnpm typecheck` → PASS/clean.

- [ ] **Step 5: Wire the 3 passthroughs** into `docker/docker-compose.yml` `x-app-env` (mirror the `GATEWAY_OAUTH_*` block, `${VAR:-}` soft defaults) and document in `docker/.env.example`.

- [ ] **Step 6: Commit**
```bash
git add packages/config/src/env.ts packages/config/tests/env.test.ts docker/docker-compose.yml docker/.env.example
git commit -m "feat(config): GATEWAY_UPSTREAM_AUTH_{MAX_FAIL,BACKOFF_SEC,GRACE_SEC} + compose wiring"
```

### Task 4: Metrics counters (2)

**Files:**
- Modify: `apps/gateway/src/plugins/metrics.ts` (mirror the existing `oauthRefreshDeadTotal` Counter at ~line 202)
- Test: `apps/gateway/tests/plugins/metrics.test.ts`

- [ ] **Step 1: Add the counter names to the scrape test** `METRIC_NAMES` array (the test that asserts all gw_ counters register):
```typescript
  "gw_upstream_auth_failed_total",
  "gw_upstream_credential_degraded_total",
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/gateway && pnpm vitest run tests/plugins/metrics.test.ts` → FAIL (not registered).

- [ ] **Step 3: Register the two counters** (mirror `oauthRefreshDeadTotal`'s `new Counter({...})` + the `gwMetrics` decoration object):
```typescript
  const upstreamAuthFailedTotal = new Counter({
    name: "gw_upstream_auth_failed_total",
    help: "Upstream api_key 401s counted toward credential-health degradation (excludes grace-window).",
    labelNames: ["platform"] as const,
    registers: [register],
  });
  const upstreamCredentialDegradedTotal = new Counter({
    name: "gw_upstream_credential_degraded_total",
    help: "api_key upstreams paused on the healthy->degraded transition (a credential went dead).",
    labelNames: ["platform"] as const,
    registers: [register],
  });
```
Expose them on the `gwMetrics` decoration object as `upstreamAuthFailedTotal` and `upstreamCredentialDegradedTotal` (mirror how `oauthRefreshDeadTotal` is exposed, and add them to the `GatewayMetrics` interface).

- [ ] **Step 4: Run to verify it passes + typecheck** — `cd apps/gateway && pnpm vitest run tests/plugins/metrics.test.ts && pnpm typecheck` → PASS/clean.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/plugins/metrics.ts apps/gateway/tests/plugins/metrics.test.ts
git commit -m "feat(gateway): upstream auth-failed + credential-degraded metrics counters"
```

---
## Phase 3 — The health helper

### Task 5: `upstreamAuthHealth.ts` — `recordAuthFailure` / `clearAuthFailure`

**Files:**
- Create: `apps/gateway/src/runtime/upstreamAuthHealth.ts`
- Test: `apps/gateway/tests/runtime/upstreamAuthHealth.test.ts`

> Unit tests cover the control flow (401-only, type guard, grace short-circuit, threshold→degrade-once, 2xx→clear+recover, error-swallow, metric-on-transition) with `ioredis-mock` + a fake drizzle chain. The NULL-safe degrade SQL correctness is verified end-to-end in Task 14 against a real Postgres.

- [ ] **Step 1: Write the failing tests**
```typescript
// apps/gateway/tests/runtime/upstreamAuthHealth.test.ts
import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { recordAuthFailure, clearAuthFailure } from "../../src/runtime/upstreamAuthHealth.js";

const acct = (over: Partial<{ id: string; type: string; platform: string }> = {}) =>
  ({ id: "a1", type: "api_key", platform: "anthropic", ...over }) as never;

function fakeDb(rowCount = 1) {
  const where = vi.fn(() => ({ returning: vi.fn(async () => Array.from({ length: rowCount }, () => ({ id: "a1" }))) }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as never, update, set, where };
}
function deps(over: Partial<Record<string, unknown>> = {}) {
  const redis = new RedisMock() as unknown as Redis;
  const f = fakeDb();
  return {
    redis, db: f.db, f,
    maxFail: 3, backoffSec: 3600, graceSec: 120,
    metrics: { authFailedTotal: { inc: vi.fn() }, credentialDegradedTotal: { inc: vi.fn() } },
    logger: { warn: vi.fn() },
    ...over,
  } as never;
}

describe("recordAuthFailure", () => {
  it("ignores non-401 (403) — no incr, no degrade", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 403);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("ignores oauth accounts", async () => {
    const d = deps();
    await recordAuthFailure(d, acct({ type: "oauth" }), 401);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
  });
  it("counts a 401 but does not degrade below threshold", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.authFailedTotal.inc).toHaveBeenCalledWith({ platform: "anthropic" });
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("degrades on the Nth 401 and counts the transition once", async () => {
    const d = deps();
    await recordAuthFailure(d, acct(), 401);
    await recordAuthFailure(d, acct(), 401);
    await recordAuthFailure(d, acct(), 401); // n === 3 === maxFail
    expect(d.f.update).toHaveBeenCalledTimes(1);
    expect(d.metrics.credentialDegradedTotal.inc).toHaveBeenCalledTimes(1);
  });
  it("skips entirely while a grace key is present", async () => {
    const d = deps();
    await d.redis.set("authgrace:a1", "1");
    for (let i = 0; i < 5; i++) await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.authFailedTotal.inc).not.toHaveBeenCalled();
    expect(d.f.update).not.toHaveBeenCalled();
  });
  it("does not count the degraded transition when the DB write affected 0 rows", async () => {
    const f = fakeDb(0);
    const d = deps({ db: f.db, f });
    for (let i = 0; i < 3; i++) await recordAuthFailure(d, acct(), 401);
    expect(d.metrics.credentialDegradedTotal.inc).not.toHaveBeenCalled();
  });
  it("never throws when redis errors", async () => {
    const redis = { exists: vi.fn().mockRejectedValue(new Error("down")) } as never;
    const d = deps({ redis });
    await expect(recordAuthFailure(d, acct(), 401)).resolves.toBeUndefined();
  });
});

describe("clearAuthFailure", () => {
  it("DELs the counter and issues a reason-gated recover update", async () => {
    const d = deps();
    await d.redis.set("authfail:a1", "2");
    await clearAuthFailure(d, acct());
    expect(await d.redis.get("authfail:a1")).toBeNull();
    expect(d.f.update).toHaveBeenCalledTimes(1); // recover
  });
  it("never throws when db errors", async () => {
    const f = fakeDb();
    f.where.mockImplementation(() => { throw new Error("db down"); });
    const d = deps({ db: f.db, f });
    await expect(clearAuthFailure(d, acct())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/gateway && pnpm vitest run tests/runtime/upstreamAuthHealth.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**
```typescript
// apps/gateway/src/runtime/upstreamAuthHealth.ts
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { upstreamAccounts, type Database } from "@caliber/db";
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";
import type { Redis } from "ioredis";

const DEGRADE_REASON = "api_key_invalid_credential";
const COUNTER_TTL_SEC = 24 * 60 * 60; // safety reclaim for silent accounts

interface CounterMetric { inc(labels: { platform: string }): void }
export interface AuthHealthDeps {
  db: Database;
  redis: Redis;
  maxFail: number;
  backoffSec: number;
  graceSec: number;
  metrics: { authFailedTotal: CounterMetric; credentialDegradedTotal: CounterMetric };
  logger: { warn: (obj: unknown, msg: string) => void };
}
interface AuthAccount { id: string; type: string; platform: string }

/**
 * Record an upstream 401 against an api_key account. Best-effort: never throws
 * into the request path. Only a 401 on an api_key account counts; a grace
 * window (just-rotated) short-circuits. On the Nth counted 401 the account is
 * paused recoverably (temp fields only — never `status`, so the scheduler
 * re-admits it when the window lapses). The degraded metric counts only the
 * healthy->degraded DB transition.
 */
export async function recordAuthFailure(
  deps: AuthHealthDeps,
  account: AuthAccount,
  status: number,
): Promise<void> {
  if (status !== 401 || account.type !== "api_key") return;
  try {
    if (await deps.redis.exists(authGraceKey(account.id))) return;
    const key = authFailKey(account.id);
    const n = await deps.redis.incr(key);
    await deps.redis.expire(key, COUNTER_TTL_SEC);
    deps.metrics.authFailedTotal.inc({ platform: account.platform });
    if (n < deps.maxFail) return;
    const until = new Date(Date.now() + deps.backoffSec * 1000);
    const rows = await deps.db
      .update(upstreamAccounts)
      .set({
        tempUnschedulableUntil: until,
        tempUnschedulableReason: DEGRADE_REASON,
        errorMessage: "upstream rejected credential (401)",
      })
      .where(
        and(
          eq(upstreamAccounts.id, account.id),
          or(
            isNull(upstreamAccounts.tempUnschedulableReason),
            ne(upstreamAccounts.tempUnschedulableReason, DEGRADE_REASON),
            isNull(upstreamAccounts.tempUnschedulableUntil),
            lt(upstreamAccounts.tempUnschedulableUntil, new Date()),
          ),
        ),
      )
      .returning({ id: upstreamAccounts.id });
    if (rows.length === 1) {
      deps.metrics.credentialDegradedTotal.inc({ platform: account.platform });
    }
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err, accountId: account.id },
      "upstream auth-health record failed (swallowed)",
    );
  }
}

/** Reset on success: DEL the counter + recover an account degraded for OUR reason. */
export async function clearAuthFailure(
  deps: AuthHealthDeps,
  account: AuthAccount,
): Promise<void> {
  try {
    await deps.redis.del(authFailKey(account.id));
    await deps.db
      .update(upstreamAccounts)
      .set({ tempUnschedulableUntil: null, tempUnschedulableReason: null, errorMessage: null })
      .where(and(eq(upstreamAccounts.id, account.id), eq(upstreamAccounts.tempUnschedulableReason, DEGRADE_REASON)));
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err, accountId: account.id },
      "upstream auth-health clear failed (swallowed)",
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes + typecheck** — `cd apps/gateway && pnpm vitest run tests/runtime/upstreamAuthHealth.test.ts && pnpm typecheck` → PASS/clean.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/runtime/upstreamAuthHealth.ts apps/gateway/tests/runtime/upstreamAuthHealth.test.ts
git commit -m "feat(gateway): upstreamAuthHealth record/clear (401 threshold degrade, grace, recover, best-effort)"
```

---
## Phase 4 — Failover loop wiring + route alignment

### Task 6: `authHealth` deps on `RunFailoverInput`, assembled in `buildFailoverInput` from `req.server`

**Files:**
- Modify: `apps/gateway/src/runtime/upstreamAuthHealth.ts` (export the loop-deps type)
- Modify: `apps/gateway/src/runtime/failoverLoop.ts` (`RunFailoverInput.authHealth?`)
- Modify: `apps/gateway/src/runtime/buildFailoverInput.ts` (assemble from `req.server`; add to the `Omit`)
- Test: `apps/gateway/tests/runtime/buildFailoverInput.test.ts` (extend)

- [ ] **Step 1: Export the loop-deps type** — in `upstreamAuthHealth.ts` add:
```typescript
export type AuthHealthLoopDeps = Omit<AuthHealthDeps, "db">;
```

- [ ] **Step 2: Add the optional field to `RunFailoverInput`** (`failoverLoop.ts`, in the interface):
```typescript
import type { AuthHealthLoopDeps } from "./upstreamAuthHealth.js";
// ...inside RunFailoverInput<T>:
  /**
   * api_key credential-health deps (redis/config/metrics/logger), assembled
   * by buildFailoverInput from req.server. Absent in unit tests that build the
   * input by hand → the loop's auth-health hooks no-op.
   */
  authHealth?: AuthHealthLoopDeps;
```

- [ ] **Step 3: Write the failing test** (`buildFailoverInput.test.ts`) — a fake `req` with a decorated `server` yields `authHealth`; a fake `req` whose `server.redis` is undefined yields `authHealth === undefined`. (Follow the file's existing fake-req pattern; set `req.server = { redis, gwMetrics, env, log }`.)

- [ ] **Step 4: Run to verify it fails** — `cd apps/gateway && pnpm vitest run tests/runtime/buildFailoverInput.test.ts` → FAIL.

- [ ] **Step 5: Implement in `buildFailoverInput.ts`** — add `"authHealth"` to the `Omit<...>` in `RouteFailoverFields`, then in the returned object (before `...fields`):
```typescript
  const app = req.server;
  // VERIFY decoration names against server.ts: app.redis, app.gwMetrics, app.env, app.log.
  const authHealth = app.redis
    ? {
        redis: app.redis,
        maxFail: app.env.GATEWAY_UPSTREAM_AUTH_MAX_FAIL,
        backoffSec: app.env.GATEWAY_UPSTREAM_AUTH_BACKOFF_SEC,
        graceSec: app.env.GATEWAY_UPSTREAM_AUTH_GRACE_SEC,
        metrics: {
          authFailedTotal: app.gwMetrics.upstreamAuthFailedTotal,
          credentialDegradedTotal: app.gwMetrics.upstreamCredentialDegradedTotal,
        },
        logger: app.log,
      }
    : undefined;
  return {
    db,
    orgId: apiKey.orgId,
    teamId: apiKey.teamId,
    groupId: apiKey.groupId ?? null,
    routingPolicy: ctx.policy,
    userId: apiKey.userId,
    platform: ctx.platform,
    authHealth,
    ...fields,
  };
```

- [ ] **Step 6: Run to verify it passes + typecheck** — `pnpm vitest run tests/runtime/buildFailoverInput.test.ts && pnpm typecheck`. Route callsites are unchanged (they pass only `fields`).

- [ ] **Step 7: Commit**
```bash
git add apps/gateway/src/runtime/upstreamAuthHealth.ts apps/gateway/src/runtime/failoverLoop.ts apps/gateway/src/runtime/buildFailoverInput.ts apps/gateway/tests/runtime/buildFailoverInput.test.ts
git commit -m "feat(gateway): thread authHealth deps onto RunFailoverInput via req.server (zero route change)"
```

### Task 7: Failover loop — `clearAuthFailure` on success, `recordAuthFailure` on `auth_invalid`

**Files:**
- Modify: `apps/gateway/src/runtime/failoverLoop.ts` (success ~246, switch_account ~298)
- Test: `apps/gateway/tests/runtime/failoverLoop.authHealth.test.ts`

> The loop's `account` candidate must expose `type` and `platform` (upstream_accounts columns). If the scheduler's selected candidate shape omits them, add them to that select first (verify in `scheduler.ts`).

- [ ] **Step 1: Write the failing test** — a `runFailover` harness (mirror the existing failoverLoop tests) with an injected `authHealth` (fake redis + spies) and an `attempt` that (a) returns success → assert `clearAuthFailure` ran (counter DEL); (b) throws `{ status: 401 }` then a second account succeeds → assert `recordAuthFailure` ran for the failing account (metric inc). Provide `authHealth` on the input.

- [ ] **Step 2: Run to verify it fails** — `cd apps/gateway && pnpm vitest run tests/runtime/failoverLoop.authHealth.test.ts` → FAIL.

- [ ] **Step 3: Implement** — import the helpers; in the success branch, before `return result`:
```typescript
        scheduler.reportResult(account.id, true);
        if (input.authHealth) {
          await clearAuthFailure(
            { ...input.authHealth, db: input.db },
            { id: account.id, type: account.type, platform: account.platform },
          );
        }
        await release();
        return result;
```
In the `switch_account` block (after the existing `if (action.stateUpdate) applyAccountStateUpdate(...)`, which is now a no-op for auth_invalid):
```typescript
        if (action.reason === "auth_invalid" && input.authHealth) {
          await recordAuthFailure(
            { ...input.authHealth, db: input.db },
            { id: account.id, type: account.type, platform: account.platform },
            "status" in upstreamErr ? upstreamErr.status : 0,
          );
        }
        await giveUp(true);
        break;
```

- [ ] **Step 4: Run to verify it passes + the existing failover suite stays green** — `pnpm vitest run tests/runtime/failoverLoop* && pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/runtime/failoverLoop.ts apps/gateway/tests/runtime/failoverLoop.authHealth.test.ts
git commit -m "feat(gateway): centralize api_key auth-health in the failover loop (clear on 2xx, record on auth_invalid)"
```

### Task 8: `/v1/messages` anthropic non-stream — throw all non-2xx into the loop

**Files:**
- Modify: `apps/gateway/src/routes/messages.ts:459-463`
- Test: covered by the Task 14 integration test (no isolated unit seam; this is a one-branch removal).

- [ ] **Step 1: Implement** — in `makeMessagesAnthropicHandler`'s non-stream attempt, **remove** the early 4xx-return so all non-2xx fall through to the existing `<200 || >=300 → throw` (~466). Concretely, delete:
```typescript
        if (upstream.status >= 400 && upstream.status < 500) {
          // 4xx errors are client errors — forward them directly without failover.
          return upstream;
        }
```
Now a 401 throws → loop → `auth_invalid` → `recordAuthFailure` + failover; a 400/422 throws → classifier `fatal` → `FatalUpstreamError` `{error,detail,request_id}` (status preserved); a 403 throws → failover (no degrade). This matches every other surface.

- [ ] **Step 2: Typecheck + run the messages suites** — `cd apps/gateway && pnpm typecheck && pnpm vitest run tests/integration/messages* --config vitest.integration.config.ts`. Fix any existing test that asserted a raw-4xx-body passthrough on this path (update it to expect the `{error,detail,request_id}` fatal wrapper with the status preserved — this is the intentional shape change).

- [ ] **Step 3: Commit**
```bash
git add apps/gateway/src/routes/messages.ts
git commit -m "fix(gateway): messages anthropic non-stream throws all non-2xx (auth-health + consistency with other surfaces)"
```

---
## Phase 5 — API rotate health reset

### Task 9: `accounts.rotate` + `rotateOwn` clear degraded state + counter + set grace

**Files:**
- Modify: `apps/api/src/trpc/routers/accounts.ts` (`rotate` ~545-630, `rotateOwn` ~348-428)
- Test: `apps/api/tests/integration/accounts.rotate.health.integration.test.ts` (testcontainer; mirror existing accounts integration tests)

> `ctx.redis` is the `caliber:gw:`-prefixed client (`context.ts:51`); use the same `authFailKey`/`authGraceKey` suffix helpers from `@caliber/gateway-core/redis`. Reset is reason-gated (anti-stomp). Add a small shared helper to avoid duplicating across the two mutations.

- [ ] **Step 1: Write the failing integration test** — seed an api_key account already degraded (`tempUnschedulableReason='api_key_invalid_credential'`, `tempUnschedulableUntil` future, `errorMessage` set) + a Redis `authfail:<id>` counter; call `accounts.rotate({ id, credentials })`; assert: the row's temp fields + errorMessage are NULL, the Redis counter is gone, and `authgrace:<id>` exists with a TTL. Second case: an account paused for a DIFFERENT reason (e.g. `oauth_refresh_exhausted`) is NOT cleared by an api_key rotate (anti-stomp).

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && pnpm vitest run --config vitest.integration.config.ts tests/integration/accounts.rotate.health.integration.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add a shared helper near the credential helpers (`routers/_credentials.ts` or inline), and call it from both `rotate` and `rotateOwn` AFTER the successful `credential_vault` reseal:
```typescript
import { and, eq } from "drizzle-orm";
import { upstreamAccounts } from "@caliber/db";
import { authFailKey, authGraceKey } from "@caliber/gateway-core/redis";

async function resetApiKeyCredentialHealth(
  ctx: { db: Database; redis: Redis; env: ServerEnv },
  accountId: string,
): Promise<void> {
  // Reason-gated: only clear a pause WE set (don't stomp oauth/rate-limit/overload).
  await ctx.db
    .update(upstreamAccounts)
    .set({ tempUnschedulableUntil: null, tempUnschedulableReason: null, errorMessage: null })
    .where(and(
      eq(upstreamAccounts.id, accountId),
      eq(upstreamAccounts.tempUnschedulableReason, "api_key_invalid_credential"),
    ));
  // Best-effort Redis (never fail a rotate on a redis hiccup):
  try {
    await ctx.redis.del(authFailKey(accountId));
    await ctx.redis.set(authGraceKey(accountId), "1", "EX", ctx.env.GATEWAY_UPSTREAM_AUTH_GRACE_SEC);
  } catch {
    // grace/counter are an optimization; the next upstream 2xx clears the counter anyway.
  }
}
```
Call `await resetApiKeyCredentialHealth(ctx, input.id)` at the end of each mutation's success path (after the vault `CAS` update, before the audit/return). (Confirm `ctx.env` is on the tRPC context; if not, read the three knobs from wherever the router accesses env.)

- [ ] **Step 4: Run to verify it passes + accounts suite** — `cd apps/api && pnpm vitest run --config vitest.integration.config.ts tests/integration/accounts* && pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/trpc/routers/accounts.ts apps/api/src/trpc/routers/_credentials.ts apps/api/tests/integration/accounts.rotate.health.integration.test.ts
git commit -m "feat(api): rotate/rotateOwn clear api_key credential-degraded health + counter + grace window"
```

---
## Phase 6 — Web surfacing

### Task 10: `deriveAccountStatus` → `credential_invalid`

**Files:**
- Modify: `apps/web/src/components/accounts/status.tsx` (union ~8, input type ~29, function ~45-78)
- Test: `apps/web/tests/components/accounts/status.test.ts` (extend if present, else create)

- [ ] **Step 1: Write the failing test**
```typescript
import { describe, it, expect } from "vitest";
import { deriveAccountStatus } from "@/components/accounts/status";

describe("deriveAccountStatus credential_invalid", () => {
  it("returns credential_invalid when reason is api_key_invalid_credential", () => {
    const r = {
      schedulable: true, status: "error", errorMessage: "upstream rejected credential (401)",
      tempUnschedulableUntil: new Date(Date.now() + 3600_000).toISOString(),
      tempUnschedulableReason: "api_key_invalid_credential",
    } as never;
    expect(deriveAccountStatus(r)).toBe("credential_invalid");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && pnpm vitest run tests/components/accounts/status.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add `"credential_invalid"` to the `AccountStatus` union (~8); add `tempUnschedulableReason?: string | null` to the input type (~29); insert the check after the `overloaded` branch and BEFORE the generic `paused` branch (~60):
```typescript
  if (row.tempUnschedulableReason === "api_key_invalid_credential") {
    return "credential_invalid";
  }
```
Also add a `credential_invalid` case to the `StatusBadge` label/variant map in the same file (red/destructive, label key `accounts.status.credentialInvalid`).

- [ ] **Step 4: Run to verify it passes + typecheck** — `pnpm vitest run tests/components/accounts/status.test.ts && pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/accounts/status.tsx apps/web/tests/components/accounts/status.test.ts
git commit -m "feat(web): credential_invalid account status + badge"
```

### Task 11: `AccountList` amber banner + rotate CTA for dead api_key credentials

**Files:**
- Modify: `apps/web/src/components/accounts/AccountList.tsx` (~241-286, mirror the oauth_invalid_grant banner)
- Test: `apps/web/tests/components/accounts/AccountList.credentialInvalid.test.tsx`

- [ ] **Step 1: Write the failing test** — render `AccountList` with one account whose `tempUnschedulableReason === 'api_key_invalid_credential'` (mock `accounts.list` per the existing AccountList test pattern); assert the banner text (the i18n key `accounts.credentialInvalidTitle`) renders and a "rotate" button is present that opens the `RotateCredentialDialog` (shipped #203).

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && pnpm vitest run tests/components/accounts/AccountList.credentialInvalid.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — add a filter + banner mirroring `invalidGrantAccounts` (lines ~243-286):
```typescript
  const deadCredentialAccounts = accounts.filter(
    (r) => r.tempUnschedulableReason === "api_key_invalid_credential",
  );
```
Render an amber `Card` (copy the oauth banner markup) gated on `deadCredentialAccounts.length > 0`, using i18n keys `accounts.credentialInvalidTitle` / `accounts.credentialInvalidBody`, with a button (single-account case) that calls `setRotatingAccount({ id, name })` (the `RotateCredentialDialog` state already wired in #203). Place it next to the existing invalid-grant banner.

- [ ] **Step 4: Run to verify it passes + typecheck** — `pnpm vitest run tests/components/accounts/AccountList* && pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/accounts/AccountList.tsx apps/web/tests/components/accounts/AccountList.credentialInvalid.test.tsx
git commit -m "feat(web): dead-api_key-credential banner + rotate CTA on org accounts"
```

### Task 12: Member status page CTA (`CredentialHealthSection`)

**Files:**
- Modify: `apps/web/src/components/status/CredentialHealthSection.tsx`
- Test: `apps/web/tests/components/status/CredentialHealthSection.test.tsx` (extend)

- [ ] **Step 1: Write the failing test** — an own upstream with `tempUnschedulableReason === 'api_key_invalid_credential'` renders the `credential_invalid` badge (via `deriveAccountStatus`) AND a "rotate" CTA linking to `/dashboard/upstreams`.

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && pnpm vitest run tests/components/status/CredentialHealthSection.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — the badge surfaces automatically (Task 10). Add a small CTA row when any own upstream is `credential_invalid`: a link/button to `/dashboard/upstreams` (where the member `UpstreamRotateDialog` lives), i18n key `status.credentialInvalidCta`.

- [ ] **Step 4: Run to verify it passes + typecheck** — `pnpm vitest run tests/components/status/* && pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/status/CredentialHealthSection.tsx apps/web/tests/components/status/CredentialHealthSection.test.tsx
git commit -m "feat(web): member status page surfaces dead-credential + rotate CTA"
```

### Task 13: i18n strings (5 locales)

**Files:**
- Modify: `apps/web/messages/{en,zh-TW,zh-CN,ja,ko}.json`

- [ ] **Step 1:** Add the new keys to ALL 5 catalogs (mirror how `accounts.reonboard*` / `status.*` keys exist across catalogs): `accounts.status.credentialInvalid`, `accounts.credentialInvalidTitle`, `accounts.credentialInvalidBody`, `status.credentialInvalidCta`. zh-TW first (operator's locale); en; reasonable translations for zh-CN/ja/ko consistent with sibling phrasing. Every catalog MUST have all keys (build/typecheck breaks otherwise).

- [ ] **Step 2: Verify** — `cd apps/web && pnpm typecheck && pnpm vitest run` (the i18n-validation guard + component tests) → green.

- [ ] **Step 3: Commit**
```bash
git add apps/web/messages
git commit -m "i18n: credential-invalid banner/badge/CTA strings (5 locales)"
```

---
## Phase 7 — Integration + green

### Task 14: End-to-end integration (testcontainer + fake upstream)

**Files:**
- Test: `apps/gateway/tests/integration/credentialHealth.integration.test.ts`

> Reuse the existing testcontainer harness (real Postgres + a fake HTTP upstream + a deterministic scheduler), mirroring `messages.aliasCache.integration.test.ts` / `openaiAlias.integration.test.ts` (per-credential forced status, seed own/pool api_key upstream, `app.redis` injected, usage_logs poll). This is where the NULL-safe degrade SQL (finding #2) and the messages-non-stream alignment (finding #1) are proven against a real DB.

- [ ] **Step 1: Write the tests** (single file, several `it`s):
  - **degrade after N** — fake anthropic upstream returns 401 for the seeded pool api_key account; POST `/v1/messages` (non-stream) N=3 times → assert the row now has `tempUnschedulableReason='api_key_invalid_credential'` + `tempUnschedulableUntil` in the future + `errorMessage='upstream rejected credential (401)'` (proves the **first degrade on a NULL-reason healthy row actually writes** — finding #2 guard), and `gw_upstream_credential_degraded_total` incremented exactly once (scrape internal metrics).
  - **scheduler skips after degrade** — a further request with no other candidate → 503 `no_upstream_available` (the degraded account is filtered out).
  - **recover on rotation** — call the rotate path (or directly clear via the gateway 2xx path) → the row's temp fields clear and the account schedules again.
  - **400 does NOT degrade / does NOT clear** — fake upstream 400 → client gets the `{error,detail,request_id}` fatal wrapper (status 400 preserved), the counter is untouched, the account stays healthy.
  - **403 fails over, does not degrade** — fake upstream 403 on account A, 200 on account B → request 200 via B; A is NOT degraded.
  - **messages non-stream 401 reaches the loop** — confirms the Task 8 change (a 401 on the anthropic non-stream path now degrades after N, vs the old return-without-degrade).

- [ ] **Step 2: Run** — `cd apps/gateway && pnpm vitest run --config vitest.integration.config.ts tests/integration/credentialHealth.integration.test.ts` → PASS. Iterate on the harness until green.

- [ ] **Step 3: Commit**
```bash
git add apps/gateway/tests/integration/credentialHealth.integration.test.ts
git commit -m "test(gateway): end-to-end api_key credential health (degrade/skip/recover/400-403 guards)"
```

### Task 15: Full suites + typechecks green

- [ ] **Step 1:** Run everything touched:
```bash
cd packages/gateway-core && pnpm vitest run && pnpm build && pnpm typecheck
cd ../config && pnpm vitest run && pnpm typecheck
cd ../../apps/gateway && pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts && pnpm typecheck
cd ../api && pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts && pnpm typecheck
cd ../web && pnpm vitest run && pnpm typecheck
cd ../.. && pnpm turbo run typecheck   # whole monorepo (must be 18/18)
```
Expected: all PASS, typechecks clean. Fix any regression before continuing.

- [ ] **Step 2: Commit** any fixups
```bash
git commit -am "test: green credential-health suites across core/config/gateway/api/web"
```

---

## Self-Review (completed)

- **Spec coverage:** trigger threshold + 401-only + Redis counter (T5), zero-status degrade + NULL-safe condition + scheduler auto-readmit (T5/T14), centralized loop placement + req.server DI (T6/T7), messages non-stream alignment (T8), classifier reconciliation (T2), rotation reset + grace race-guard (T9), surfacing badge/banner/CTA (T10–12), metrics on transition (T4/T5), config knobs (T3), shared suffix keys in gateway-core (T1), i18n (T13), end-to-end + edge guards (T14). All covered.
- **Placeholders:** none — every code step shows real code; the few "verify the decoration/column name" notes are explicit verification steps against named files, not silent TODOs.
- **Type consistency:** `AuthHealthDeps`/`AuthHealthLoopDeps`, `recordAuthFailure(deps, account, status)`/`clearAuthFailure(deps, account)`, `authFailKey`/`authGraceKey`, reason literal `api_key_invalid_credential`, metric names `gw_upstream_auth_failed_total`/`gw_upstream_credential_degraded_total`, env knobs `GATEWAY_UPSTREAM_AUTH_{MAX_FAIL,BACKOFF_SEC,GRACE_SEC}`, status `credential_invalid` — used consistently across tasks.
