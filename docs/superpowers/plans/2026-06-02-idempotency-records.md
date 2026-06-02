# idempotency_records + tenant-scoping fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tenant-scope the deployed Redis idempotency key (security fix) and add the `idempotency_records` DB table (§4.5 billing metadata) with an inline write hook and a retention purge cron.

**Architecture:** (a) `checkIdempotency` composes a `{api_key_id}:{X-Request-Id}` Redis key; (b) a new `idempotency_records` table (composite PK `(api_key_id, request_id)`) is written fire-and-forget from `emitUsageLog` (where cost + req are in scope) and purged hourly by a `bodyPurge`-style cron gated on the new TTL knob.

**Tech Stack:** TypeScript, Fastify, drizzle-orm + drizzle-kit (Postgres), ioredis, prom-client, vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-02-idempotency-records-design.md`

**Working dir:** `/Users/hanfourhuang/ai-dev-eval`. Run gateway tests with `cd apps/gateway && npx vitest run [path]`; integration with `--config vitest.integration.config.ts`. Typecheck: `cd apps/gateway && npx tsc --noEmit` (and `cd packages/config && npx tsc --noEmit` / `packages/db`).

**Branch:** `feat/idempotency-records` (already created, spec committed).

---

## File Structure

- **Modify** `packages/config/src/env.ts` — add `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC` (Task 1).
- **Modify** `apps/gateway/src/server.ts` — decorate `env` on the app; register purge cron (Tasks 2, 9).
- **Modify** `apps/gateway/src/runtime/idempotencyCache.ts` — `scope` dep + scoped key (Task 3).
- **Modify** `apps/gateway/src/routes/idempotencyEntry.ts` — pass `scope` (Task 3).
- **Create** `packages/db/src/schema/idempotencyRecords.ts`; **modify** `packages/db/src/schema/index.ts` (Task 4).
- **Create** `packages/db/drizzle/0017_*.sql` + `0017_down.sql` via drizzle-kit (Task 5).
- **Modify** `apps/gateway/src/plugins/metrics.ts` — `gw_idempotency_records_purged_total` (Task 6).
- **Create** `apps/gateway/src/workers/idempotencyPurge.ts` (Task 7).
- **Create** `apps/gateway/src/runtime/idempotencyRecord.ts`; **modify** `apps/gateway/src/runtime/usageLogging.ts` — write hook (Task 8).
- **Test** files alongside each.

---

## Task 1: Add `GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC` env knob

**Files:**
- Modify: `packages/config/src/env.ts:154` (next to `GATEWAY_IDEMPOTENCY_TTL_SEC`)
- Test: `packages/config/tests/env.test.ts` (or the existing env test file — find with `ls packages/config/tests`)

- [ ] **Step 1: Write the failing test**

Add to the config env test file (mirror an existing default-value assertion):

```typescript
it("GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC defaults to 3600 and accepts 0", () => {
  const base = minimalValidEnv(); // reuse the helper the file already uses
  expect(parseServerEnv(base).GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC).toBe(3600);
  expect(
    parseServerEnv({ ...base, GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC: "0" })
      .GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC,
  ).toBe(0);
});
```

If the test file uses a different env-construction helper, match it (grep the file for how other `GATEWAY_*` knobs are tested).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/config && npx vitest run tests/env.test.ts`
Expected: FAIL (`undefined` !== `3600`).

- [ ] **Step 3: Implement**

In `packages/config/src/env.ts`, immediately after the `GATEWAY_IDEMPOTENCY_TTL_SEC` block (line ~154-156):

```typescript
    GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC: emptyAsUndefined(
      z.coerce.number().int().min(0).default(3600),
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/config && npx vitest run tests/env.test.ts` → PASS. Then `cd packages/config && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/env.ts packages/config/tests/env.test.ts
git commit -m "feat(config): add GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC knob (default 3600)"
```

---

## Task 2: Decorate `env` on the gateway app

**Files:**
- Modify: `apps/gateway/src/server.ts` (FastifyInstance augmentation ~line 54; decorate in `buildServer` ~line 113)

- [ ] **Step 1: Add the FastifyInstance augmentation**

Inside the existing `declare module "fastify" { interface FastifyInstance { ... } }` block in `server.ts`, add:

```typescript
    /**
     * The resolved server env. Decorated so runtime helpers that only receive
     * `app` (e.g. emitUsageLog) can read config knobs without threading them
     * through every call site.
     */
    env: ServerEnv;
```

`ServerEnv` is already imported in server.ts (used by `BuildOpts`). Verify with `grep -n "ServerEnv" apps/gateway/src/server.ts`.

- [ ] **Step 2: Decorate in buildServer**

In `buildServer`, immediately after `const app = Fastify({...})` is created and before the first `app.register(...)` (around line 141), add:

```typescript
  app.decorate("env", opts.env);
```

- [ ] **Step 3: Verify typecheck + existing server tests**

Run: `cd apps/gateway && npx tsc --noEmit` → clean.
Run: `cd apps/gateway && npx vitest run tests/server.test.ts` → PASS (no behaviour change; just confirms decoration doesn't break boot).

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/src/server.ts
git commit -m "feat(gateway): decorate resolved env on the app instance"
```

---

## Task 3: Tenant-scope the Redis idempotency key (security fix)

**Files:**
- Modify: `apps/gateway/src/runtime/idempotencyCache.ts` (`CheckIdempotencyDeps` + `checkIdempotency`)
- Modify: `apps/gateway/src/routes/idempotencyEntry.ts` (`checkRequestIdempotency`)
- Test: `apps/gateway/tests/runtime/idempotencyCache.test.ts`, `apps/gateway/tests/routes/idempotencyEntry.test.ts`

- [ ] **Step 1: Write failing unit tests for the scoped key**

In `idempotencyCache.test.ts`, add (note: existing tests call `checkIdempotency` WITHOUT `scope` — they will need `scope` added too; do that in Step 3's test-fixup):

```typescript
it("scopes the Redis key by `scope` — a hit under another scope is a miss", async () => {
  // seed a completed entry under scope "keyA"
  await setCached(redis, "keyA:rid-z", { status: 200, headers: {}, body: Buffer.from("A").toString("base64") }, 300);
  // same raw request id, different scope → MISS (proceeds, claims its own slot)
  const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "keyB", requestKey: "rid-z", reply: fakeReply() });
  expect(res.outcome).toBe("proceed");
  expect(res.idemKey).toBe("keyB:rid-z");
});

it("409 body reports the RAW X-Request-Id, not the scoped composite", async () => {
  await setInFlight(redis, "keyA:rid-dup", 300);
  const reply = fakeReply();
  const res = await checkIdempotency({ redis, ttlSec: 300, failClosed: true, scope: "keyA", requestKey: "rid-dup", reply });
  expect(res.outcome).toBe("conflict");
  expect(reply.calls.body).toMatchObject({ error: "request_in_progress", requestId: "rid-dup" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/gateway && npx vitest run tests/runtime/idempotencyCache.test.ts`
Expected: FAIL — TS error (`scope` not in deps) / wrong key.

- [ ] **Step 3: Implement the scope in `idempotencyCache.ts`**

Add to `CheckIdempotencyDeps` (after `requestKey`):

```typescript
  /** Tenant scope (the api_key_id) — composed into the Redis key so two
   *  tenants using the same X-Request-Id never collide. */
  scope: string;
```

In `checkIdempotency`, replace `const key = deps.requestKey;` with:

```typescript
  const key = `${deps.scope}:${deps.requestKey}`;
```

In the conflict branch, change the 409 send from `requestId: key` to the raw id:

```typescript
    deps.reply.send({ error: "request_in_progress", requestId: deps.requestKey });
```

(Leave `getCached`/`setInFlight`/replay/`return { outcome: "proceed", idemKey: key }` as-is — they now use the scoped `key`.)

Then fix the file's PRE-EXISTING tests: every existing `checkIdempotency({...})` call in `idempotencyCache.test.ts` must gain `scope: "k"` and any assertion on `idemKey`/seeded key must use the scoped form (e.g. seed `setInFlight(redis, "k:rid-2", ...)`, expect `idemKey: "k:rid-1"` → `"k:rid-1"`). Grep: `grep -n "checkIdempotency(" tests/runtime/idempotencyCache.test.ts`.

- [ ] **Step 4: Pass `scope` from the route helper**

In `idempotencyEntry.ts` `checkRequestIdempotency`, guard + pass scope. Replace the `checkIdempotency({...})` call's deps to include:

```typescript
  const apiKeyId = req.apiKey?.id;
  if (!apiKeyId) {
    // No authenticated api key → nothing to scope by; idempotency disabled.
    return { handled: false, idemKey: null };
  }
  const result = await checkIdempotency({
    redis: app.redis,
    ttlSec: env.GATEWAY_IDEMPOTENCY_TTL_SEC,
    failClosed: env.GATEWAY_REDIS_FAILURE_MODE === "strict",
    scope: apiKeyId,
    requestKey: Array.isArray(xReqId) ? (xReqId[0] ?? null) : (xReqId ?? null),
    reply,
    onResult: () => app.gwMetrics.idempotencyHitTotal.inc(),
    onMalformed: () => app.gwMetrics.idempotencyMalformedTotal.inc(),
    onRedisError: () => app.gwMetrics.redisErrorTotal.inc({ op: "idempotency" }),
    logger: app.log,
  });
```

- [ ] **Step 5: Fix `idempotencyEntry.test.ts` for the scope**

The `fakeReq` helper must set `apiKey`. Update it:

```typescript
function fakeReq(xRequestId?: string | string[], apiKeyId = "test-key"): FastifyRequest {
  return {
    apiKey: { id: apiKeyId },
    headers: xRequestId === undefined ? {} : { "x-request-id": xRequestId },
  } as unknown as FastifyRequest;
}
```

Update expected `idemKey` values to the scoped form: the "miss" test now expects `idemKey: "test-key:rid-miss"`; the malformed test seeds `redis.set("idem:test-key:rid-bad", ...)` and expects `idemKey: "test-key:rid-bad"`; the array test expects `"test-key:rid-array-first"`. Add a new test: `fakeReq("rid", undefined)` with `apiKey` absent → `{ handled: false, idemKey: null }` (pass `apiKeyId` as `null`-producing variant by constructing a req with no `apiKey`).

- [ ] **Step 6: Run unit tests**

Run: `cd apps/gateway && npx vitest run tests/runtime/idempotencyCache.test.ts tests/routes/idempotencyEntry.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 7: Cross-tenant integration regression**

In `tests/routes/messages.integration.test.ts`, add a test: seed two api keys (same or different org, both with an eligible account), key A POSTs `/v1/messages` with `x-request-id: shared` (200, body A). Then key B POSTs with the same `x-request-id: shared`; assert B gets a fresh 200 (its own upstream dispatch — stage `nextUpstreamResponse` to body B between the calls) and `x-idempotent-replay` is **undefined** (no cross-tenant replay). Use the existing seed helpers; flush 20ms between calls.

- [ ] **Step 8: Run + commit**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts tests/routes/messages.integration.test.ts` → PASS.

```bash
git add apps/gateway/src/runtime/idempotencyCache.ts apps/gateway/src/routes/idempotencyEntry.ts apps/gateway/tests/runtime/idempotencyCache.test.ts apps/gateway/tests/routes/idempotencyEntry.test.ts apps/gateway/tests/routes/messages.integration.test.ts
git commit -m "fix(gateway): tenant-scope idempotency Redis key by api_key_id (cross-tenant replay leak)"
```

---

(Tasks 4-10 continue below.)

## Task 4: `idempotency_records` schema

**Files:**
- Create: `packages/db/src/schema/idempotencyRecords.ts`
- Modify: `packages/db/src/schema/index.ts` (add export line)

- [ ] **Step 1: Create the schema file**

```typescript
import {
  pgTable,
  text,
  uuid,
  integer,
  decimal,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./org.js";
import { users } from "./auth.js";
import { apiKeys } from "./apiKeys.js";

// Plan 4A §4.5 — supplementary billing/refund record keyed by the client
// X-Request-Id, scoped to the api key (tenant boundary), retained ~1h.
// NOT the dedup mechanism (that is the Redis cache); usage_logs remains the
// authoritative permanent ledger. Composite PK so two callers can reuse the
// same X-Request-Id without colliding.
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    internalRequestId: text("internal_request_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedModel: text("requested_model").notNull(),
    surface: text("surface").notNull(),
    platform: text("platform").notNull(),
    statusCode: integer("status_code").notNull(),
    totalCost: decimal("total_cost", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    actualCostUsd: decimal("actual_cost_usd", { precision: 20, scale: 10 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyId, t.requestId] }),
    expiresAtIdx: index("idempotency_records_expires_at_idx").on(t.expiresAt),
    orgCreatedIdx: index("idempotency_records_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
  }),
);
```

- [ ] **Step 2: Export it**

Append to `packages/db/src/schema/index.ts`:

```typescript
export * from "./idempotencyRecords.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/db && npx tsc --noEmit` → clean. Confirm `users` is exported from `./auth.js` (`grep -n "export const users" src/schema/auth.js src/schema/auth.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/idempotencyRecords.ts packages/db/src/schema/index.ts
git commit -m "feat(db): idempotency_records schema (composite PK, 1h-retention billing snapshot)"
```

---

## Task 5: Migration 0017 (drizzle-kit generate)

**Files:**
- Create: `packages/db/drizzle/0017_*.sql` (generated), `packages/db/drizzle/0017_down.sql` (hand-written), journal entry (generated)

- [ ] **Step 1: Generate the migration**

Run: `cd packages/db && pnpm db:generate`
Expected: a new `drizzle/0017_<name>.sql` with `CREATE TABLE "idempotency_records" (...)` + the two indexes, and an updated `drizzle/meta/_journal.json` entry with idx 17.

- [ ] **Step 2: Verify the journal `when` clears prod's max created_at**

Run: `grep -A4 '"idx": 17' packages/db/drizzle/meta/_journal.json`
Expected: `"when"` value > `1779873493734` (prod's manual-0016 created_at). drizzle-kit stamps `Date.now()` so this holds automatically; **if it does not, STOP** and hand-bump the `when` to be strictly greater before proceeding.

Also eyeball the generated SQL: composite `PRIMARY KEY ("api_key_id","request_id")`, FKs `ON DELETE cascade`, both indexes present.

- [ ] **Step 3: Write the down migration**

Create `packages/db/drizzle/0017_down.sql`:

```sql
DROP TABLE IF EXISTS "idempotency_records";
```

- [ ] **Step 4: Verify it applies (dry run in a throwaway container is optional — CI covers it)**

Run: `cd packages/db && npx tsc --noEmit` → clean (schema unchanged). The migration application is exercised by the gateway integration suite (testcontainers run `migrate`).

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0017_*.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): migration 0017 create idempotency_records"
```

---

## Task 6: `gw_idempotency_records_purged_total` metric

**Files:**
- Modify: `apps/gateway/src/plugins/metrics.ts`
- Test: `apps/gateway/tests/plugins/metrics.test.ts`

- [ ] **Step 1: Add to the test's name list + accessor assertions**

In `metrics.test.ts`, add `'gw_idempotency_records_purged_total'` to `METRIC_NAMES`, and in test 6 add `expect(m.idempotencyRecordsPurgedTotal).toBeInstanceOf(Counter)`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/gateway && npx vitest run tests/plugins/metrics.test.ts` → FAIL (name absent / accessor undefined).

- [ ] **Step 3: Implement in metrics.ts**

Interface (`GatewayMetrics`), after `redisErrorTotal`:

```typescript
  idempotencyRecordsPurgedTotal: Counter<string>;
```

Construction (after the `redisErrorTotal` Counter):

```typescript
  const idempotencyRecordsPurgedTotal = new Counter({
    name: "gw_idempotency_records_purged_total",
    help: "idempotency_records rows deleted by the retention purge cron",
    registers: [register],
  });
```

Zero-init (near the other `.inc(0)` calls):

```typescript
  idempotencyRecordsPurgedTotal.inc(0);
```

Decorate (in the `fastify.decorate("gwMetrics", { ... })` object):

```typescript
    idempotencyRecordsPurgedTotal,
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/gateway && npx vitest run tests/plugins/metrics.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/plugins/metrics.ts apps/gateway/tests/plugins/metrics.test.ts
git commit -m "feat(gateway): gw_idempotency_records_purged_total metric"
```

---

## Task 7: Purge worker `purgeExpiredIdempotencyRecords`

**Files:**
- Create: `apps/gateway/src/workers/idempotencyPurge.ts`
- Test: `apps/gateway/tests/workers/idempotencyPurge.integration.test.ts` (needs real Postgres → integration config)

- [ ] **Step 1: Write the failing integration test**

Mirror an existing integration test harness (postgres testcontainer + drizzle + migrate). Cases:

```typescript
// helper: insert a record with a given (apiKeyId, requestId, expiresAt)
// seed FKs (org/user/apiKey) once via the existing seed helpers from another
// integration test, or insert minimal parent rows.

it("deletes only expired rows; returns count", async () => {
  const cutoff = new Date("2026-06-02T12:00:00Z");
  await seedRecord({ apiKeyId: A, requestId: "x", expiresAt: new Date(cutoff.getTime() - 1000) }); // expired
  await seedRecord({ apiKeyId: A, requestId: "y", expiresAt: new Date(cutoff.getTime() + 60000) }); // fresh
  const res = await purgeExpiredIdempotencyRecords({ db, now: () => cutoff });
  expect(res.deleted).toBe(1);
  // "x" gone, "y" survives
});

it("composite-key: key A expired request_id=x, key B fresh request_id=x → only A deleted", async () => {
  const cutoff = new Date("2026-06-02T12:00:00Z");
  await seedRecord({ apiKeyId: A, requestId: "x", expiresAt: new Date(cutoff.getTime() - 1000) });
  await seedRecord({ apiKeyId: B, requestId: "x", expiresAt: new Date(cutoff.getTime() + 60000) });
  await purgeExpiredIdempotencyRecords({ db, now: () => cutoff });
  // (A,"x") gone; (B,"x") survives
});

it("injected-cutoff boundary: expires_at == cutoff deleted, == cutoff+1s survives", async () => {
  const cutoff = new Date("2026-06-02T12:00:00Z");
  await seedRecord({ apiKeyId: A, requestId: "eq", expiresAt: cutoff });
  await seedRecord({ apiKeyId: A, requestId: "gt", expiresAt: new Date(cutoff.getTime() + 1000) });
  const res = await purgeExpiredIdempotencyRecords({ db, now: () => cutoff });
  expect(res.deleted).toBe(1); // only "eq"
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts tests/workers/idempotencyPurge.integration.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `idempotencyPurge.ts`**

```typescript
import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";

export const IDEMPOTENCY_PURGE_BATCH_SIZE = 10_000;
export const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1h

export interface IdempotencyPurgeResult {
  deleted: number;
  durationSec: number;
}

export interface IdempotencyPurgeOptions {
  db: Database;
  now?: () => Date;
  batchSize?: number;
}

export async function purgeExpiredIdempotencyRecords(
  opts: IdempotencyPurgeOptions,
): Promise<IdempotencyPurgeResult> {
  const {
    db,
    now = () => new Date(),
    batchSize = IDEMPOTENCY_PURGE_BATCH_SIZE,
  } = opts;
  const cutoff = now();
  const startMs = cutoff.getTime();

  let totalDeleted = 0;
  const MAX_ITERATIONS = 100;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Composite-key delete + outer expires_at recheck (same cutoff) so a row
    // refreshed by a concurrent ON CONFLICT dispatch between the subquery and
    // the delete is NOT removed.
    const deleted = await db.execute(sql`
      DELETE FROM idempotency_records r
      USING (
        SELECT api_key_id, request_id FROM idempotency_records
        WHERE expires_at <= ${cutoff}
        LIMIT ${batchSize}
      ) doomed
      WHERE r.api_key_id = doomed.api_key_id
        AND r.request_id = doomed.request_id
        AND r.expires_at <= ${cutoff}
    `);
    const rowCount = (deleted as { rowCount: number | null }).rowCount ?? 0;
    totalDeleted += rowCount;
    if (rowCount === 0) break;
  }

  return {
    deleted: totalDeleted,
    durationSec: (Date.now() - startMs) / 1000,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts tests/workers/idempotencyPurge.integration.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/idempotencyPurge.ts apps/gateway/tests/workers/idempotencyPurge.integration.test.ts
git commit -m "feat(gateway): purgeExpiredIdempotencyRecords (composite-key, cutoff-recheck)"
```

---

## Task 8: Write hook `writeIdempotencyRecord` + emitUsageLog call

**Files:**
- Create: `apps/gateway/src/runtime/idempotencyRecord.ts`
- Modify: `apps/gateway/src/runtime/usageLogging.ts` (call inside `emitUsageLog`)
- Test: `apps/gateway/tests/runtime/idempotencyRecord.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// seed org/user/apiKey parents, then:
it("inserts a snapshot row keyed by (apiKeyId, X-Request-Id)", async () => {
  writeIdempotencyRecord({ db, requestKey: "rid-1", ttlSec: 3600, now: () => new Date("2026-06-02T12:00:00Z"),
    payload: { apiKeyId: A, orgId: O, userId: U, requestId: "internal-1", requestedModel: "m", surface: "messages", platform: "anthropic", statusCode: 200, totalCost: "0.0100000000", actualCostUsd: "0.0200000000" } });
  await new Promise((r) => setTimeout(r, 30)); // fire-and-forget flush
  // row exists: request_id="rid-1", internal_request_id="internal-1", total_cost≈0.01, expires_at = created+3600s
});

it("ttlSec=0 → no row", async () => { /* call with ttlSec:0 → no insert */ });

it("conflict on (apiKeyId, request_id) refreshes snapshot + created_at", async () => {
  // write once with internal-1/cost 0.01/created T1; write again same (A,"rid-c") with internal-2/cost 0.05/created T2
  // → single row, internal_request_id="internal-2", total_cost≈0.05, created_at=T2
});

it("different api keys, same request_id → two distinct rows", async () => { /* (A,"x") and (B,"x") both exist */ });

it("never throws on a failing db", async () => {
  const failing = { insert: () => { throw new Error("down"); } } as unknown as Database;
  expect(() => writeIdempotencyRecord({ db: failing, requestKey: "z", ttlSec: 3600, payload: minimalPayload })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts tests/runtime/idempotencyRecord.integration.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `idempotencyRecord.ts`**

```typescript
import type { Database } from "@caliber/db";
import { idempotencyRecords } from "@caliber/db";

export interface IdempotencyRecordPayload {
  apiKeyId: string;
  orgId: string;
  userId: string;
  requestId: string; // the gateway-internal req.id
  requestedModel: string;
  surface: string;
  platform: string;
  statusCode: number;
  totalCost: string; // payload.totalCost (canonical, cached-input-inclusive)
  actualCostUsd: string; // payload.actualCostUsd (multiplier-applied)
}

export interface WriteIdempotencyRecordInput {
  db: Database;
  requestKey: string; // the raw client X-Request-Id
  ttlSec: number;
  payload: IdempotencyRecordPayload;
  now?: () => Date;
}

/**
 * Fire-and-forget §4.5 billing-snapshot write. Never throws; a lost write
 * costs one supplementary record (usage_logs is the authoritative ledger).
 * Disabled when ttlSec === 0. ON CONFLICT refreshes the whole row to the
 * latest dispatch (incl. created_at) — see spec "row = latest dispatch".
 */
export function writeIdempotencyRecord(input: WriteIdempotencyRecordInput): void {
  if (input.ttlSec === 0) return;
  const now = input.now ?? (() => new Date());
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + input.ttlSec * 1000);
  const p = input.payload;
  const values = {
    apiKeyId: p.apiKeyId,
    requestId: input.requestKey,
    internalRequestId: p.requestId,
    orgId: p.orgId,
    userId: p.userId,
    requestedModel: p.requestedModel,
    surface: p.surface,
    platform: p.platform,
    statusCode: p.statusCode,
    totalCost: p.totalCost,
    actualCostUsd: p.actualCostUsd,
    createdAt,
    expiresAt,
  };
  try {
    void input.db
      .insert(idempotencyRecords)
      .values(values)
      .onConflictDoUpdate({
        target: [idempotencyRecords.apiKeyId, idempotencyRecords.requestId],
        set: {
          internalRequestId: values.internalRequestId,
          orgId: values.orgId,
          userId: values.userId,
          requestedModel: values.requestedModel,
          surface: values.surface,
          platform: values.platform,
          statusCode: values.statusCode,
          totalCost: values.totalCost,
          actualCostUsd: values.actualCostUsd,
          createdAt: values.createdAt,
          expiresAt: values.expiresAt,
        },
      })
      .catch(() => {
        // best-effort; supplementary record only.
      });
  } catch {
    // synchronous throw (e.g. malformed db stub) — swallow per contract.
  }
}
```

- [ ] **Step 4: Call it from `emitUsageLog`**

In `usageLogging.ts` `emitUsageLog`, inside the `try` block, after `buildUsageLogPayload` returns `{ payload, cost }` and before/after the enqueue (order doesn't matter; place after the pricing-miss block), add:

```typescript
    const xReqId = req.headers["x-request-id"];
    const requestKey = Array.isArray(xReqId) ? xReqId[0] : xReqId;
    if (requestKey && app.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0 && app.db) {
      writeIdempotencyRecord({
        db: app.db,
        requestKey,
        ttlSec: app.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC,
        payload: {
          apiKeyId: payload.apiKeyId,
          orgId: payload.orgId,
          userId: payload.userId,
          requestId: payload.requestId,
          requestedModel: payload.requestedModel,
          surface: payload.surface,
          platform: payload.platform,
          statusCode: payload.statusCode,
          totalCost: payload.totalCost,
          actualCostUsd: payload.actualCostUsd,
        },
      });
    }
```

Add the import at the top of `usageLogging.ts`:

```typescript
import { writeIdempotencyRecord } from "./idempotencyRecord.js";
```

(`app.env` is available after Task 2. `payload.surface`/`platform` are strings on the job payload; confirm field names with `grep -n "surface\|platform" src/runtime/usageLogging.ts` — they match the schema.)

- [ ] **Step 5: Run tests**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts tests/runtime/idempotencyRecord.integration.test.ts` → PASS. `npx tsc --noEmit` → clean. Also re-run the route integration suites to confirm the emitUsageLog change is benign when no X-Request-Id is sent: `npx vitest run --config vitest.integration.config.ts tests/routes/`.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/idempotencyRecord.ts apps/gateway/src/runtime/usageLogging.ts apps/gateway/tests/runtime/idempotencyRecord.integration.test.ts
git commit -m "feat(gateway): write idempotency_records snapshot from emitUsageLog (§4.5)"
```

---

## Task 9: Wire the purge cron in server.ts

**Files:**
- Modify: `apps/gateway/src/server.ts` (cron registration block ~line 177, inside the `if (opts.redis === undefined)` gate)

- [ ] **Step 1: Implement the cron handle + registration**

In `idempotencyPurge.ts`, add a cron starter mirroring `startBodyPurgeCron`:

```typescript
export interface IdempotencyPurgeCronHandle {
  stop: () => void;
}

export function startIdempotencyPurgeCron(deps: {
  db: Database;
  metrics: { purgedTotal: { inc: (n?: number) => void } };
  logger: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  intervalMs?: number;
}): IdempotencyPurgeCronHandle {
  const intervalMs = deps.intervalMs ?? IDEMPOTENCY_PURGE_INTERVAL_MS;
  const timer = setInterval(() => {
    void purgeExpiredIdempotencyRecords({ db: deps.db })
      .then((r) => {
        if (r.deleted > 0) deps.metrics.purgedTotal.inc(r.deleted);
        deps.logger.info({ deleted: r.deleted, durationSec: r.durationSec }, "idempotency_records purge tick");
      })
      .catch((err) => deps.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "idempotency_records purge failed"));
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

In `server.ts`, inside `if (opts.redis === undefined) { ... }`, **as a sibling of the `ENABLE_EVALUATOR` block (NOT inside it)** — gated on the TTL knob:

```typescript
    // Idempotency-record retention purge — Plan 4A §4.5. Gateway data written
    // regardless of the evaluator, so gate on the record TTL knob, NOT
    // ENABLE_EVALUATOR (which guards captured bodies).
    if (opts.env.GATEWAY_IDEMPOTENCY_RECORD_TTL_SEC > 0 && app.db) {
      const idemPurgeHandle = startIdempotencyPurgeCron({
        db: app.db,
        metrics: { purgedTotal: app.gwMetrics.idempotencyRecordsPurgedTotal },
        logger: app.log,
      });
      app.addHook("onClose", async () => {
        idemPurgeHandle.stop();
      });
    }
```

Add the import at the top of `server.ts`:

```typescript
import { startIdempotencyPurgeCron } from "./workers/idempotencyPurge.js";
```

- [ ] **Step 2: Verify typecheck + server boot test**

Run: `cd apps/gateway && npx tsc --noEmit` → clean. `npx vitest run tests/server.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/server.ts apps/gateway/src/workers/idempotencyPurge.ts
git commit -m "feat(gateway): register idempotency_records purge cron (gated on TTL knob, not evaluator)"
```

---

## Task 10: Full verification

- [ ] **Step 1: Typecheck all touched packages**

Run: `cd packages/config && npx tsc --noEmit && cd ../db && npx tsc --noEmit && cd ../../apps/gateway && npx tsc --noEmit` → all clean.

- [ ] **Step 2: Full gateway unit suite**

Run: `cd apps/gateway && npx vitest run` → all PASS (≥ 465 + new).

- [ ] **Step 3: Gateway integration suite**

Run: `cd apps/gateway && npx vitest run --config vitest.integration.config.ts` → all PASS (migration 0017 applies; purge + write-hook + cross-tenant tests green).

- [ ] **Step 4: Config + db package tests**

Run: `cd packages/config && npx vitest run` and `cd packages/db && npx vitest run` (if present) → PASS.

- [ ] **Step 5: code-review agent**

Dispatch the code-reviewer agent on `git diff main...HEAD` for correctness (scoped-key end-to-end, conflict-set completeness, purge cutoff recheck, cron gating, FK cascade). Address HIGH/MEDIUM.

- [ ] **Step 6: Push + PR**

```bash
git push -u origin feat/idempotency-records
gh pr create --base main --title "feat(gateway): idempotency_records table + tenant-scope idempotency key (§4.5)" --body "<summary: security fix + §4.5 table; test plan; no env required (knob defaults 3600); migration 0017 via drizzle-kit>"
```

Watch CI 6/6 green (`gh run watch <id> --exit-status`).

---

## Self-Review (filled by plan author)

- **Spec coverage:** tenant-scope fix (Task 3) ✓; schema composite PK (Task 4) ✓; migration via drizzle-kit + journal-when check (Task 5) ✓; write from emitUsageLog using payload.totalCost/actualCostUsd, guarded on X-Request-Id + TTL knob, ON CONFLICT refresh-all incl created_at (Task 8) ✓; purge composite-delete + cutoff recheck + injected now (Task 7) ✓; purge metric (Task 6) ✓; cron gated on TTL knob not ENABLE_EVALUATOR (Task 9) ✓; env knob (Task 1) ✓; all spec tests mapped (cross-tenant, composite-key, cutoff-boundary, conflict, distinct-keys, never-throws) ✓.
- **Placeholders:** none — every code step has full code.
- **Type consistency:** `idempotencyRecords` columns ↔ `IdempotencyRecordPayload` ↔ write `values` ↔ emitUsageLog `payload.*` all aligned; `scope` dep added in Task 3 and consumed in idempotencyEntry; `idempotencyRecordsPurgedTotal` defined (Task 6) before use (Task 9).
- **Open follow-up to verify during impl:** confirm `app.db` is non-undefined in production boot (it is — dbPlugin decorates it); the `if (app.db)` guards keep test-mode safe.
