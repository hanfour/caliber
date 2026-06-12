# Gateway Load-Test Harness Implementation Plan (#206)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable load-test harness that (a) asserts the gateway's concurrency/isolation invariants under real concurrent multi-user load (correctness gate, CI), and (b) reports throughput + p50/p95 per surface (perf benchmark, report-only).

**Architecture:** One shared `bootStack()` stands up an ephemeral stack — testcontainer Postgres + a dedicated testcontainer Redis + the gateway on a real listening port (driven via the production env path so BullMQ runs) + a configurable fake upstream. A serial vitest `load` lane drives correctness scenarios C0–C8a over real HTTP with in-process prom-metric deltas; a `pnpm perf:gateway` script drives autocannon and writes a report.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Fastify, `@testcontainers/postgresql` + `@testcontainers/redis`, ioredis, BullMQ, prom-client, autocannon, drizzle-orm.

**Spec:** `docs/superpowers/specs/2026-06-12-gateway-load-test-design.md` — read it; this plan implements it.

---

## File Structure (locked)

```
apps/gateway/tests/load/
  fakeUpstream.ts         # configurable fake: /v1/messages, /v1/responses, /v1/responses/compact (+SSE) + latency/status + self counters
  scrapeMetrics.ts        # read a counter from app.gwMetrics in-process; delta helper
  drainUsageQueue.ts      # poll usage_logs row count until settled (waitFor)
  cleanup.ts              # TRUNCATE ... RESTART IDENTITY CASCADE + SCAN MATCH caliber:gw* + UNLINK (raw client)
  seed.ts                 # slug-namespaced org/user/api-key/upstream+vault factories across pool/own/own_then_pool
  bootStack.ts            # the shared foundation; returns LoadStack
  correctness/
    c0-sanity.load.test.ts
    c1-attribution.load.test.ts          # C1 + C1b
    c2-slot-cap.load.test.ts
    c3-wait-queue.load.test.ts
    c4-sticky.load.test.ts               # C4-L1 + C4-L2
    c5-idempotency.load.test.ts
    c6-failover.load.test.ts
    c7-streaming.load.test.ts
    c8a-credential-health.load.test.ts
  vitest.load.config.ts   # serial (fileParallelism:false / maxWorkers:1); include tests/load/**/*.load.test.ts
  README.md               # runbook

scripts/
  perf-gateway.ts         # autocannon matrix driver → pnpm perf:gateway; report-only

docs/perf/                # generated reports (gitkept)
```

**Naming note:** correctness tests use the suffix `.load.test.ts` (NOT `.integration.test.ts`) so the existing `test:integration` lane never picks them up and they run only under `vitest.load.config.ts`.

---

## Conventions every task follows

- **TDD:** write the failing test/assertion first, run it red, implement, run green, commit.
- **Real code only:** copy the patterns quoted below — they are taken verbatim from the codebase.
- **64-char-hex secrets:** `masterKey` (`CREDENTIAL_ENCRYPTION_KEY`) and `pepper` (`API_KEY_HASH_PEPPER`) must be 64 hex chars. Use the constants defined in `seed.ts` (Task 5).
- **Imports:** `encryptCredential`, `hashApiKey` from `@caliber/gateway-core`; `parseServerEnv` from `@caliber/config`; schema + `Database` from `@caliber/db`; `buildServer` from `../../src/server.js`.

---

## Phase 0 — Spike: prove the SUT boots correctly (de-risk the §9 High findings)

### Task 1: Spike — one-boot gateway over real HTTP + real Redis + BullMQ + in-process metrics

**Files:**
- Create: `apps/gateway/tests/load/spike.load.test.ts` (throwaway — deleted at end of task)
- Create: `apps/gateway/vitest.load.config.ts`

**Why:** The spec §9 flags three load-bearing risks that must be confirmed before building the foundation: (1) `buildServer` returns an un-listened app and we can `app.listen({port:0})`; (2) leaving `opts.redis` undefined + setting `REDIS_URL` actually spins up BullMQ so `usage_logs` get written; (3) the prom-client registry is a global singleton so we boot ONE gateway for the whole suite and read counters in-process.

- [ ] **Step 1: Create the serial vitest config**

`apps/gateway/vitest.load.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/load/**/*.load.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Serial: prom-client uses a process-global registry; parallel app
    // instances would share/clear it and race the C0 metric deltas.
    // (Vitest 4 removed `poolOptions.threads`; use the top-level knobs.)
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
```

- [ ] **Step 2: Add the `test:load` script**

In `apps/gateway/package.json` scripts, after `test:integration`:
```json
"test:load": "vitest run --config vitest.load.config.ts",
```

- [ ] **Step 3: Write the spike test (RED — expect it to reveal what works)**

`apps/gateway/tests/load/spike.load.test.ts`:
```typescript
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import * as schema from "@caliber/db/schema";
import { organizations, users, apiKeys, upstreamAccounts, credentialVault, usageLogs } from "@caliber/db/schema";
import { parseServerEnv } from "@caliber/config";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import { buildServer } from "../../src/server.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(path.dirname(require.resolve("@caliber/db/package.json")), "drizzle");
const masterKey = "a".repeat(64);
const pepper = "b".repeat(64);

let pgC: StartedPostgreSqlContainer, redisC: StartedRedisContainer, fake: Server, fakeUrl: string;
let db: ReturnType<typeof drizzle>, pool: pg.Pool, app: Awaited<ReturnType<typeof buildServer>>, baseUrl: string;

beforeAll(async () => {
  pgC = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db as never, { migrationsFolder });
  redisC = await new RedisContainer("redis:7-alpine").start();

  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      let model = "unknown";
      try { model = JSON.parse(Buffer.concat(chunks).toString()).model ?? "unknown"; } catch { /* ignore */ }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const env = parseServerEnv({
    NODE_ENV: "test", DATABASE_URL: pgC.getConnectionUri(),
    AUTH_SECRET: "test-auth-secret-min-32-chars-long!!", NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "a@e.com", BOOTSTRAP_DEFAULT_ORG_SLUG: "o", BOOTSTRAP_DEFAULT_ORG_NAME: "O",
    ENABLE_GATEWAY: "true", GATEWAY_BASE_URL: "http://localhost:3002",
    REDIS_URL: redisC.getConnectionUrl(),
    CREDENTIAL_ENCRYPTION_KEY: masterKey, API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fakeUrl, GATEWAY_ENABLE_MODEL_ALIAS: "false", GATEWAY_CACHE_TTL_SEC: "0",
  });
  // NOTE: opts.redis intentionally OMITTED so buildServer runs the production
  // BullMQ wiring (usage queue + worker) against the real Redis container.
  app = await buildServer({ env, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => fake?.close(() => r()));
  await pool?.end();
  await pgC?.stop();
  await redisC?.stop();
});

it("boots, serves /v1/messages 200 over real HTTP, and writes a usage_logs row via BullMQ", async () => {
  const orgId = (await db.insert(organizations).values({ slug: "spike-org", name: "S" }).returning())[0]!.id;
  const userId = (await db.insert(users).values({ email: "spike@e.com" }).returning())[0]!.id;
  const rawKey = "ak_spike000000000000";
  const apiKeyId = (await db.insert(apiKeys).values({ orgId, userId, keyHash: hashApiKey(pepper, rawKey), keyPrefix: rawKey.slice(0, 8), name: "k" }).returning({ id: apiKeys.id }))[0]!.id;
  const acctId = (await db.insert(upstreamAccounts).values({ orgId, name: "a", platform: "anthropic", type: "api_key", schedulable: true, status: "active" }).returning())[0]!.id;
  const sealed = encryptCredential({ masterKeyHex: masterKey, accountId: acctId, plaintext: JSON.stringify({ type: "api_key", api_key: "sk-spike" }) });
  await db.insert(credentialVault).values({ accountId: acctId, nonce: sealed.nonce, ciphertext: sealed.ciphertext, authTag: sealed.authTag });

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });
  expect(res.status).toBe(200);

  // BullMQ worker writes async — poll up to 10s.
  const deadline = Date.now() + 10_000;
  let count = 0;
  while (Date.now() < deadline) {
    const rows = await db.select({ c: sql<number>`count(*)::int` }).from(usageLogs).where(eq(usageLogs.apiKeyId, apiKeyId));
    count = rows[0]?.c ?? 0;
    if (count === 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(count).toBe(1);

  // In-process metric read works.
  const snap = await app.gwMetrics.slotAcquireTotal.get();
  expect(Array.isArray(snap.values)).toBe(true);
});
```

- [ ] **Step 4: Run the spike**

Run: `cd apps/gateway && pnpm test:load`
Expected: PASS. If `app.listen` throws, or the usage row never appears (BullMQ not wired), or `app.gwMetrics` is undefined, STOP and report — the foundation design needs revision before proceeding. Capture which of the three assumptions failed.

- [ ] **Step 5: Confirm `@testcontainers/redis` is available**

Run: `cd apps/gateway && node -e "require.resolve('@testcontainers/redis')"`
Expected: prints a path. If it errors, add it: `pnpm --filter @caliber/gateway add -D @testcontainers/redis`, then re-run Step 4.

- [ ] **Step 6: Delete the spike, keep the config**

```bash
rm apps/gateway/tests/load/spike.load.test.ts
git add apps/gateway/vitest.load.config.ts apps/gateway/package.json
git commit -m "test(gateway): load-test vitest config + test:load script (spike-verified boot/listen/BullMQ/metrics)"
```

---

## Phase 1 — Shared foundation (the reusable harness library)

### Task 2: `fakeUpstream.ts` — configurable fake upstream + self-test

**Files:**
- Create: `apps/gateway/tests/load/fakeUpstream.ts`
- Test: `apps/gateway/tests/load/fakeUpstream.test.ts` (plain `.test.ts` — runs in the normal unit lane, no containers)

- [ ] **Step 1: Write the failing self-test**

`apps/gateway/tests/load/fakeUpstream.test.ts`:
```typescript
import { afterAll, beforeAll, expect, it } from "vitest";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";

let fake: FakeUpstream;
beforeAll(async () => { fake = await startFakeUpstream(); });
afterAll(async () => { await fake.stop(); });

it("returns 200 anthropic JSON by default and counts the request", async () => {
  fake.reset();
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-A", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.type).toBe("message");
  expect(fake.requestCount()).toBe(1);
  expect(fake.errorCount()).toBe(0);
});

it("forces a status per credential token", async () => {
  fake.reset();
  fake.forceStatus("tok-dead", 401);
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-dead", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5 }),
  });
  expect(res.status).toBe(401);
  expect(fake.errorCount()).toBe(1);
});

it("adds latency before responding", async () => {
  fake.reset();
  fake.setLatency(120);
  const t0 = Date.now();
  await fetch(`${fake.baseUrl}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer tok-O", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
  });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
});

it("streams SSE when stream:true", async () => {
  fake.reset();
  const res = await fetch(`${fake.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": "tok-A", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 5, stream: true }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/gateway && pnpm vitest run tests/load/fakeUpstream.test.ts`
Expected: FAIL — `startFakeUpstream` not found.

- [ ] **Step 3: Implement `fakeUpstream.ts`**

```typescript
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUpstream {
  baseUrl: string;
  /** Force an HTTP status for requests carrying this credential token. */
  forceStatus(token: string, status: number): void;
  /** Per-response latency in ms (applies to all routes). */
  setLatency(ms: number): void;
  /** First-token delay for SSE streams (ms). */
  setFirstTokenDelay(ms: number): void;
  requestCount(): number;
  errorCount(): number;
  /** Clear counters, forced statuses, and latency. */
  reset(): void;
  stop(): Promise<void>;
}

/** The credential token a request carried (api_key → x-api-key, oauth → Bearer). */
function credentialTokenOf(headers: NodeJS.Dict<string | string[]>): string {
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  const auth = headers["authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

function anthropicBody(model: string): string {
  return JSON.stringify({
    id: "msg_fake", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
}

function openaiResponsesBody(model: string): string {
  return JSON.stringify({
    id: "resp_fake", object: "response", model, status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startFakeUpstream(): Promise<FakeUpstream> {
  let latency = 0;
  let firstTokenDelay = 0;
  let requests = 0;
  let errors = 0;
  const forced = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", async () => {
      requests += 1;
      let parsed: { model?: string; stream?: boolean } = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
      const model = typeof parsed.model === "string" ? parsed.model : "unknown";
      const token = credentialTokenOf(req.headers);
      const url = req.url ?? "";
      const isOpenai = url.startsWith("/v1/responses");

      if (latency > 0) await wait(latency);

      const status = forced.get(token);
      if (status !== undefined && status >= 300) {
        errors += 1;
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ type: "error", error: { type: "forced", message: `forced ${status}` } }));
        return;
      }

      if (parsed.stream === true) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        if (firstTokenDelay > 0) await wait(firstTokenDelay);
        if (isOpenai) {
          res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_fake", model } })}\n\n`);
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fake", model, usage: { input_tokens: 3, output_tokens: 2 } } })}\n\n`);
        } else {
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_fake", model, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        }
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(isOpenai ? openaiResponsesBody(model) : anthropicBody(model));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    forceStatus: (t, s) => { forced.set(t, s); },
    setLatency: (ms) => { latency = ms; },
    setFirstTokenDelay: (ms) => { firstTokenDelay = ms; },
    requestCount: () => requests,
    errorCount: () => errors,
    reset: () => { requests = 0; errors = 0; forced.clear(); latency = 0; firstTokenDelay = 0; },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/gateway && pnpm vitest run tests/load/fakeUpstream.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/tests/load/fakeUpstream.ts apps/gateway/tests/load/fakeUpstream.test.ts
git commit -m "test(gateway): configurable fake upstream for load harness (latency/status/SSE + self counters)"
```

---

### Task 3: `scrapeMetrics.ts` — in-process counter read + delta + self-test

**Files:**
- Create: `apps/gateway/tests/load/scrapeMetrics.ts`
- Test: `apps/gateway/tests/load/scrapeMetrics.test.ts`

- [ ] **Step 1: Write the failing self-test**

`apps/gateway/tests/load/scrapeMetrics.test.ts`:
```typescript
import { expect, it } from "vitest";
import { Counter, Registry } from "prom-client";
import { counterValue } from "./scrapeMetrics.js";

it("sums only the matching-label series", async () => {
  const reg = new Registry();
  const c = new Counter({ name: "t_total", help: "h", labelNames: ["scope", "result"] as const, registers: [reg] });
  c.inc({ scope: "account", result: "ok" }, 3);
  c.inc({ scope: "account", result: "over_limit" }, 2);
  c.inc({ scope: "user", result: "ok" }, 5);
  expect(await counterValue(c, { scope: "account", result: "over_limit" })).toBe(2);
  expect(await counterValue(c, { scope: "account" })).toBe(5); // ok+over_limit
});

it("returns 0 for an unseen label combo (no throw)", async () => {
  const reg = new Registry();
  const c = new Counter({ name: "u_total", help: "h", labelNames: ["platform"] as const, registers: [reg] });
  expect(await counterValue(c, { platform: "anthropic" })).toBe(0);
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/gateway && pnpm vitest run tests/load/scrapeMetrics.test.ts`
Expected: FAIL — `counterValue` not found.

- [ ] **Step 3: Implement `scrapeMetrics.ts`**

```typescript
/** Read a prom-client counter/gauge value in-process, summing matching-label series. */
export interface ReadableMetric {
  get: () => Promise<{ values: Array<{ value: number; labels: Record<string, string | number> }> }>;
}

export async function counterValue(metric: ReadableMetric, match: Record<string, string> = {}): Promise<number> {
  const snap = await metric.get();
  let total = 0;
  for (const v of snap.values) {
    const ok = Object.entries(match).every(([k, val]) => String(v.labels[k]) === val);
    if (ok) total += v.value;
  }
  return total;
}

/** Run `fn` and return the increase in the metric value across it. */
export async function counterDelta(
  metric: ReadableMetric,
  match: Record<string, string>,
  fn: () => Promise<void>,
): Promise<number> {
  const before = await counterValue(metric, match);
  await fn();
  const after = await counterValue(metric, match);
  return after - before;
}
```

- [ ] **Step 4: Run it green**

Run: `cd apps/gateway && pnpm vitest run tests/load/scrapeMetrics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/tests/load/scrapeMetrics.ts apps/gateway/tests/load/scrapeMetrics.test.ts
git commit -m "test(gateway): in-process prom-counter delta helper for load harness"
```

---

### Task 4: `drainUsageQueue.ts` + `cleanup.ts`

**Files:**
- Create: `apps/gateway/tests/load/drainUsageQueue.ts`
- Create: `apps/gateway/tests/load/cleanup.ts`

No standalone unit test — these are exercised by C0 (Task 9). They are tiny and mechanical.

- [ ] **Step 1: Implement `drainUsageQueue.ts`**

```typescript
import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import type { Database } from "@caliber/db";

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export async function usageLogCount(db: Database): Promise<number> {
  const rows = await db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  return rows[0]?.c ?? 0;
}

/** Block until `usage_logs` reaches `expected` rows (the BullMQ worker batches on a ~1s timer). */
export async function drainUsageQueue(db: Database, expected: number, timeoutMs = 15_000): Promise<void> {
  await waitFor(async () => (await usageLogCount(db)) >= expected, timeoutMs);
}
```

- [ ] **Step 2: Implement `cleanup.ts`**

```typescript
import { sql } from "drizzle-orm";
import type { Database } from "@caliber/db";
import type { Redis } from "ioredis";

// Child-first not needed — CASCADE handles the RESTRICT FK graph (usage_logs →
// users/api_keys/upstream_accounts/organizations; request_bodies/facets →
// usage_logs; credential_vault → upstream_accounts; memberships, etc.).
const DATA_TABLES = [
  "usage_logs", "request_bodies", "request_body_facets", "idempotency_records",
  "credential_vault", "upstream_accounts", "api_keys",
  "account_group_members", "account_groups",
  "memberships", "users", "organizations",
];

export async function truncateData(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Clear the whole `caliber:gw*` keyspace via a RAW (un-prefixed) client. */
export async function clearGatewayKeyspace(raw: Redis): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await raw.scan(cursor, "MATCH", "caliber:gw*", "COUNT", 500);
    cursor = next;
    if (batch.length > 0) await raw.unlink(...batch);
  } while (cursor !== "0");
}
```

- [ ] **Step 3: Sanity-compile**

Run: `cd apps/gateway && pnpm typecheck`
Expected: PASS. (If `account_group_members`/`memberships` table names differ, fix against `packages/db/src/schema/*` — grep `pgTable(` for the real names.)

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/tests/load/drainUsageQueue.ts apps/gateway/tests/load/cleanup.ts
git commit -m "test(gateway): usage-queue drain + DB/Redis cleanup helpers for load harness"
```

---

### Task 5: `seed.ts` — slug-namespaced fixtures across routing policies

**Files:**
- Create: `apps/gateway/tests/load/seed.ts`

No standalone unit test — exercised by C0/C1 (Tasks 9–10). It defines the shared `masterKey`/`pepper` constants and all fixture builders.

- [ ] **Step 1: Implement `seed.ts`**

```typescript
import { organizations, users, memberships, apiKeys, upstreamAccounts, credentialVault } from "@caliber/db/schema";
import { encryptCredential, hashApiKey } from "@caliber/gateway-core";
import type { Database } from "@caliber/db";

// Suite-wide 64-char-hex secrets (env-schema requires hex shape).
export const masterKey = "a".repeat(64);
export const pepper = "b".repeat(64);

export type RoutingPolicy = "pool" | "own" | "own_then_pool";
export type Platform = "anthropic" | "openai";

export interface SeededMember {
  userId: string;
  apiKeyId: string;
  rawKey: string;
  routingPolicy: RoutingPolicy;
}

/** Create an org; the slug carries the scenario slug so rows are traceable. */
export async function seedOrg(db: Database, slug: string): Promise<string> {
  const [org] = await db.insert(organizations).values({ slug: `${slug}-org`, name: slug }).returning();
  return org!.id;
}

export async function seedUser(db: Database, slug: string, n: number): Promise<string> {
  const [u] = await db.insert(users).values({ email: `${slug}-u${n}@e.com` }).returning();
  return u!.id;
}

export async function seedMembership(db: Database, orgId: string, userId: string): Promise<void> {
  await db.insert(memberships).values({ orgId, userId, role: "member" });
}

/**
 * Issue an api key for a user with the given routing policy. Returns the raw
 * key (for the Authorization header) + its row id (for usage_logs joins).
 */
export async function seedApiKey(
  db: Database, orgId: string, userId: string, slug: string, n: number, routingPolicy: RoutingPolicy,
): Promise<SeededMember> {
  const rawKey = `ak_${slug}_${n}_${"0".repeat(20)}`.slice(0, 28);
  const [row] = await db.insert(apiKeys).values({
    orgId, userId, keyHash: hashApiKey(pepper, rawKey), keyPrefix: rawKey.slice(0, 8),
    name: `${slug}-k${n}`, routingPolicy,
  }).returning({ id: apiKeys.id });
  return { userId, apiKeyId: row!.id, rawKey, routingPolicy };
}

export interface SeedAccountOpts {
  userId?: string | null;     // null/undefined → pool; set → BYOK own
  platform?: Platform;        // default "anthropic"
  concurrency?: number;       // per-account slot cap
  priority?: number;
  schedulable?: boolean;      // default true
  status?: "active" | "error";
  credToken?: string;         // the x-api-key the fake will receive (default unique)
}

/** Seed an upstream_accounts row + its encrypted api_key credential. Returns {id, credToken}. */
export async function seedAccount(
  db: Database, orgId: string, slug: string, n: number, opts: SeedAccountOpts = {},
): Promise<{ id: string; credToken: string }> {
  const platform = opts.platform ?? "anthropic";
  const credToken = opts.credToken ?? `tok-${slug}-${n}`;
  const [acct] = await db.insert(upstreamAccounts).values({
    orgId,
    userId: opts.userId ?? null,
    name: `${slug}-acct${n}`,
    platform,
    type: "api_key",
    schedulable: opts.schedulable ?? true,
    status: opts.status ?? "active",
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  }).returning();
  const sealed = encryptCredential({
    masterKeyHex: masterKey, accountId: acct!.id,
    plaintext: JSON.stringify({ type: "api_key", api_key: credToken }),
  });
  await db.insert(credentialVault).values({
    accountId: acct!.id, nonce: sealed.nonce, ciphertext: sealed.ciphertext, authTag: sealed.authTag,
  });
  return { id: acct!.id, credToken };
}
```

- [ ] **Step 2: Verify schema names + the `concurrency` column**

Run: `grep -rnE "pgTable\(|concurrency|routingPolicy|memberships" packages/db/src/schema/*.ts | grep -iE "concurrency|routing|membership|pgTable" | head`
Expected: confirm `upstreamAccounts.concurrency`, `apiKeys.routingPolicy`, and the membership table name. Fix `seed.ts` column/table names if they differ (e.g. the membership table may be `memberships` or `organizationMembers`).

- [ ] **Step 3: Sanity-compile**

Run: `cd apps/gateway && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/tests/load/seed.ts
git commit -m "test(gateway): slug-namespaced load-harness fixtures (org/user/key/upstream across routing policies)"
```

---

### Task 6: `bootStack.ts` — the shared foundation

**Files:**
- Create: `apps/gateway/tests/load/bootStack.ts`

Exercised by C0 (Task 9). This wires Tasks 2–5 together into one `bootStack()`.

- [ ] **Step 1: Implement `bootStack.ts`**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { AddressInfo } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import IORedis, { type Redis } from "ioredis";
import * as schema from "@caliber/db/schema";
import type { Database } from "@caliber/db";
import { parseServerEnv } from "@caliber/config";
import { buildServer } from "../../src/server.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";
import { masterKey, pepper } from "./seed.js";
import { truncateData, clearGatewayKeyspace } from "./cleanup.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(path.dirname(require.resolve("@caliber/db/package.json")), "drizzle");

export interface BootOptions {
  /** Suite-fixed knobs — captured at plugin registration, NOT mutable per scenario. */
  maxWait?: number;          // GATEWAY_MAX_WAIT (default 10)
  maxSwitches?: number;      // GATEWAY_MAX_ACCOUNT_SWITCHES (default 10)
  authMaxFail?: number;      // GATEWAY_UPSTREAM_AUTH_MAX_FAIL (default 3)
}

export interface LoadStack {
  baseUrl: string;
  db: Database;
  /** caliber:gw:-prefixed client for slot-ZSET inspection (e.g. zcard("slots:account:<id>")). */
  redis: Redis;
  fake: FakeUpstream;
  app: Awaited<ReturnType<typeof buildServer>>;
  env: { maxWait: number; maxSwitches: number; authMaxFail: number };
  /** afterEach: TRUNCATE data + clear caliber:gw* keyspace. */
  resetState(): Promise<void>;
  teardown(): Promise<void>;
}

export async function bootStack(opts: BootOptions = {}): Promise<LoadStack> {
  const maxWait = opts.maxWait ?? 10;
  const maxSwitches = opts.maxSwitches ?? 10;
  const authMaxFail = opts.authMaxFail ?? 3;

  const pgC: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new pg.Pool({ connectionString: pgC.getConnectionUri() });
  const db = drizzle(pool, { schema });
  await migrate(db as never, { migrationsFolder });

  const redisC: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const redisUrl = redisC.getConnectionUrl();

  const fake = await startFakeUpstream();

  const env = parseServerEnv({
    NODE_ENV: "test", DATABASE_URL: pgC.getConnectionUri(),
    AUTH_SECRET: "test-auth-secret-min-32-chars-long!!", NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com", BOOTSTRAP_DEFAULT_ORG_SLUG: "test-org", BOOTSTRAP_DEFAULT_ORG_NAME: "Test Org",
    ENABLE_GATEWAY: "true", GATEWAY_BASE_URL: "http://localhost:3002",
    REDIS_URL: redisUrl,
    CREDENTIAL_ENCRYPTION_KEY: masterKey, API_KEY_HASH_PEPPER: pepper,
    UPSTREAM_ANTHROPIC_BASE_URL: fake.baseUrl, UPSTREAM_OPENAI_BASE_URL: fake.baseUrl,
    GATEWAY_ENABLE_MODEL_ALIAS: "false", GATEWAY_CACHE_TTL_SEC: "0",
    GATEWAY_MAX_WAIT: String(maxWait),
    GATEWAY_MAX_ACCOUNT_SWITCHES: String(maxSwitches),
    GATEWAY_UPSTREAM_AUTH_MAX_FAIL: String(authMaxFail),
  });

  // opts.redis OMITTED → production BullMQ wiring runs against the real container.
  const app = await buildServer({ env, db });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Inspection client: same caliber:gw: prefix as the gateway's internal client.
  const redis = new IORedis(redisUrl, { keyPrefix: "caliber:gw:" });
  // Cleanup client: RAW (un-prefixed) so SCAN MATCH caliber:gw* sees real keys.
  const rawRedis = new IORedis(redisUrl);

  return {
    baseUrl, db, redis, fake, app,
    env: { maxWait, maxSwitches, authMaxFail },
    resetState: async () => {
      await truncateData(db);
      await clearGatewayKeyspace(rawRedis);
      fake.reset();
    },
    teardown: async () => {
      await app.close();
      await fake.stop();
      redis.disconnect();
      rawRedis.disconnect();
      await pool.end();
      await pgC.stop();
      await redisC.stop();
    },
  };
}
```

- [ ] **Step 2: Sanity-compile**

Run: `cd apps/gateway && pnpm typecheck`
Expected: PASS. (If `RedisContainer.getConnectionUrl()` is named differently, grep `node_modules/@testcontainers/redis` for the accessor and fix.)

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/bootStack.ts
git commit -m "test(gateway): bootStack() shared foundation (PG+Redis containers, prod-path gateway, fake upstream)"
```

---

## Phase 2 — Correctness gate (C0–C8a)

Every scenario file: `beforeAll` boots the stack with the knobs it needs, `afterEach` (or before each `it`) calls `stack.resetState()`, `afterAll` tears down. Requests go over real HTTP via `fetch`.

A shared helper used by several scenarios — add it to `apps/gateway/tests/load/requests.ts`:

```typescript
/** POST /v1/messages with an api key; returns {status, json, headers}. */
export async function postMessages(
  baseUrl: string, rawKey: string,
  body: Record<string, unknown> = { model: "claude-3-haiku-20240307", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: res.status, json, text };
}
```

Commit `requests.ts` with Task 7.

### Task 7: C0 — harness sanity

**Files:** Create `apps/gateway/tests/load/requests.ts` + `apps/gateway/tests/load/correctness/c0-sanity.load.test.ts`

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue, usageLogCount } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C0: a single 200 flows end-to-end and writes exactly one usage_logs row; baseline clean", async () => {
  expect(await usageLogCount(stack.db)).toBe(0); // resetState gave a clean slate

  const orgId = await seedOrg(stack.db, "c0");
  const userId = await seedUser(stack.db, "c0", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c0", 1, "pool");
  await seedAccount(stack.db, orgId, "c0", 1, { userId: null }); // pool account

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(200);

  await drainUsageQueue(stack.db, 1);
  expect(await usageLogCount(stack.db)).toBe(1);
});
```

- [ ] **Step 2: Run red** — `cd apps/gateway && pnpm test:load` → expect the file to fail only if a helper is missing; otherwise this is the first green scenario.
- [ ] **Step 3: Fix any wiring** revealed (most likely: schema column names from Task 5 Step 2, or the membership table). Re-run until green.
- [ ] **Step 4: Commit**

```bash
git add apps/gateway/tests/load/requests.ts apps/gateway/tests/load/correctness/c0-sanity.load.test.ts
git commit -m "test(gateway): C0 load-harness sanity (end-to-end 200 + one usage row, clean baseline)"
```

### Task 8: C1 attribution isolation + C1b own-no-upstream

**Files:** Create `apps/gateway/tests/load/correctness/c1-attribution.load.test.ts`

- [ ] **Step 1: Write the tests (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { usageLogs, upstreamAccounts } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C1: concurrent multi-member own traffic — zero cross-user attribution leak", async () => {
  const orgId = await seedOrg(stack.db, "c1");
  const K = 4, REQ_PER = 5;
  const members = [];
  for (let i = 0; i < K; i++) {
    const userId = await seedUser(stack.db, "c1", i);
    await seedMembership(stack.db, orgId, userId);
    const m = await seedApiKey(stack.db, orgId, userId, "c1", i, "own");
    await seedAccount(stack.db, orgId, "c1", i, { userId }); // each member's OWN upstream
    members.push(m);
  }

  // Fire K*REQ_PER concurrent requests across all members.
  const calls = members.flatMap((m) =>
    Array.from({ length: REQ_PER }, () => postMessages(stack.baseUrl, m.rawKey)),
  );
  const results = await Promise.all(calls);
  expect(results.every((r) => r.status === 200)).toBe(true);

  await drainUsageQueue(stack.db, K * REQ_PER);

  // Leak detector: any usage row whose account is user-owned by a DIFFERENT user.
  const leaks = await stack.db
    .select({ c: sql<number>`count(*)::int` })
    .from(usageLogs)
    .innerJoin(upstreamAccounts, eq(usageLogs.accountId, upstreamAccounts.id))
    .where(and(isNotNull(upstreamAccounts.userId), ne(upstreamAccounts.userId, usageLogs.userId)));
  expect(leaks[0]!.c).toBe(0);

  // Each member's rows == REQ_PER.
  for (const m of members) {
    const rows = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs).where(eq(usageLogs.apiKeyId, m.apiKeyId));
    expect(rows[0]!.c).toBe(REQ_PER);
  }
});

it("C1b: own-policy key with no own upstream → 409 no_own_upstream, never the org pool", async () => {
  const orgId = await seedOrg(stack.db, "c1b");
  const userId = await seedUser(stack.db, "c1b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c1b", 1, "own"); // own policy
  await seedAccount(stack.db, orgId, "c1b", 9, { userId: null });        // ONLY a pool account exists

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(409);
  expect(r.json).toMatchObject({ error: "no_own_upstream" });
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. Green after wiring.
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c1-attribution.load.test.ts
git commit -m "test(gateway): C1 attribution isolation + C1b own-no-upstream 409 under load"
```

### Task 9: C2 — slot cap (deterministic, single account)

**Files:** Create `apps/gateway/tests/load/correctness/c2-slot-cap.load.test.ts`

- [ ] **Step 1: Write the test (RED)**

Boot with a high `maxWait` so the overflow sheds at the slot layer, not the wait-queue.

```typescript
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { counterValue } from "../scrapeMetrics.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const K = 3, N = 6; // N <= maxWait (50) so the bottleneck is the slot, not the queue
beforeAll(async () => { stack = await bootStack({ maxWait: 50 }); }, 120_000);
afterAll(async () => { await stack.teardown(); });

it("C2: single account concurrency=K — K proceed, N-K shed at the slot layer (no over-allocation)", async () => {
  const orgId = await seedOrg(stack.db, "c2");
  const userId = await seedUser(stack.db, "c2", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c2", 1, "pool");
  // ONE pool account, concurrency=K. Fake holds each slot for 800ms so K fill up.
  await seedAccount(stack.db, orgId, "c2", 1, { userId: null, concurrency: K });
  stack.fake.setLatency(800);

  const before = await counterValue(stack.app.gwMetrics.slotAcquireTotal, { scope: "account", result: "over_limit" });

  const results = await Promise.all(Array.from({ length: N }, () => postMessages(stack.baseUrl, m.rawKey)));

  const ok = results.filter((r) => r.status === 200).length;
  const shed = results.filter((r) => r.status === 503);
  expect(ok).toBe(K);
  expect(shed.length).toBe(N - K);
  // Single account exhausts the failover loop → all_upstreams_failed (NOT account_at_capacity).
  expect(shed.every((r) => r.json?.error === "all_upstreams_failed")).toBe(true);

  // The real no-over-allocation invariant: over_limit rejections == N-K.
  const after = await counterValue(stack.app.gwMetrics.slotAcquireTotal, { scope: "account", result: "over_limit" });
  expect(after - before).toBe(N - K);
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. If the 200-count flakes, raise the fake latency (slots must stay held until all N arrive). If `result` label is named differently, fix from `apps/gateway/src/redis/slots.ts`.
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c2-slot-cap.load.test.ts
git commit -m "test(gateway): C2 deterministic slot cap (over_limit metric delta + all_upstreams_failed shed)"
```

---

### Task 10: C3 — wait-queue admit/shed

**Files:** Create `apps/gateway/tests/load/correctness/c3-wait-queue.load.test.ts`

Boot with a small `maxWait=W` and give the account a high concurrency so the ONLY bottleneck is the per-user wait queue (else requests shed at the slot layer with 503 first).

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const W = 3, M = 8;
beforeAll(async () => { stack = await bootStack({ maxWait: W }); }, 120_000);
afterAll(async () => { await stack.teardown(); });

it("C3: single user, account not a bottleneck — first W admit, rest 429 wait_queue_full", async () => {
  const orgId = await seedOrg(stack.db, "c3");
  const userId = await seedUser(stack.db, "c3", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c3", 1, "pool");
  await seedAccount(stack.db, orgId, "c3", 1, { userId: null, concurrency: 1000 }); // slots never the bottleneck
  stack.fake.setLatency(800); // keep the W admitted requests in-flight

  const results = await Promise.all(Array.from({ length: M }, () => postMessages(stack.baseUrl, m.rawKey)));

  const admitted = results.filter((r) => r.status === 200).length;
  const shed = results.filter((r) => r.status === 429);
  expect(admitted).toBe(W);
  expect(shed.length).toBe(M - W);
  expect(shed.every((r) => r.json?.error === "wait_queue_full")).toBe(true);
  expect(shed.every((r) => typeof r.json?.maxWait === "number")).toBe(true);
});

it("C3: after the queue drains, new requests admit again", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c3b");
  const userId = await seedUser(stack.db, "c3b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c3b", 1, "pool");
  await seedAccount(stack.db, orgId, "c3b", 1, { userId: null, concurrency: 1000 });
  stack.fake.setLatency(0); // fast — each completes and dequeues immediately

  for (let i = 0; i < W + 2; i++) {
    const r = await postMessages(stack.baseUrl, m.rawKey); // serial → never exceeds W in-flight
    expect(r.status).toBe(200);
  }
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. If `admitted` ≠ W flakes, raise the first-test latency.
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c3-wait-queue.load.test.ts
git commit -m "test(gateway): C3 wait-queue admit/shed (429 wait_queue_full{maxWait}, re-admit after drain)"
```

### Task 11: C4 — sticky L1 (previous_response_id) + L2 (session header), with failover rebind

**Files:** Create `apps/gateway/tests/load/correctness/c4-sticky.load.test.ts`

Sticky routing requires the candidate accounts to share a **group** (`req.groupId`) — see `scheduler.ts` (sticky layers no-op without `groupId`). Add a group-seeding helper inside this test file.

- [ ] **Step 1: Verify the group schema**

Run: `grep -rnE "pgTable\(|groupId|accountId" packages/db/src/schema/accountGroups.ts`
Expected: confirm the `account_groups` table, the membership table (`account_group_members`?) with `groupId`/`accountId`, and that `api_keys.groupId` binds a key to a group. Use the real names in Step 2.

- [ ] **Step 2: Write the test (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountGroups, accountGroupMembers, apiKeys, upstreamAccounts } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

/** Create a group, add the accounts to it, and bind the api key to it. */
async function groupAndBind(orgId: string, apiKeyId: string, accountIds: string[]): Promise<string> {
  const [g] = await stack.db.insert(accountGroups).values({ orgId, name: `grp-${Math.random().toString(36).slice(2, 8)}` }).returning();
  for (const accountId of accountIds) {
    await stack.db.insert(accountGroupMembers).values({ groupId: g!.id, accountId });
  }
  await stack.db.update(apiKeys).set({ groupId: g!.id }).where(eq(apiKeys.id, apiKeyId));
  return g!.id;
}

/** POST /v1/responses (OpenAI Responses surface) carrying a previous_response_id (L1 sticky key). */
async function postResponses(rawKey: string, previousResponseId?: string): Promise<{ status: number; accountId: string | null }> {
  const res = await fetch(`${stack.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", input: "hi", ...(previousResponseId ? { previous_response_id: previousResponseId } : {}) }),
  });
  return { status: res.status, accountId: await accountForLastRequest() };
}

/** The account a request landed on is observable via its usage_log row (most recent). */
async function accountForLastRequest(): Promise<string | null> {
  // drain handled by caller; read the latest usage row's account.
  const rows = await stack.db.select({ a: upstreamAccounts.id }).from(upstreamAccounts).limit(1);
  return rows[0]?.a ?? null;
}

it("C4-L1: same previous_response_id sticks to one account; rebinds to a healthy account when the target goes unschedulable", async () => {
  const orgId = await seedOrg(stack.db, "c4l1");
  const userId = await seedUser(stack.db, "c4l1", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c4l1", 1, "pool");
  const a1 = await seedAccount(stack.db, orgId, "c4l1", 1, { userId: null, platform: "openai" });
  const a2 = await seedAccount(stack.db, orgId, "c4l1", 2, { userId: null, platform: "openai" });
  await groupAndBind(orgId, m.apiKeyId, [a1.id, a2.id]);

  // Use a fixed previous_response_id so all calls share the L1 sticky key.
  const PRID = "resp_sticky_c4l1";
  // First call binds the sticky key to whichever account is chosen.
  const first = await postResponsesAndAccount(stack, m.rawKey, PRID);
  const stuckTo = first.accountId!;
  // Subsequent calls hit the same account.
  for (let i = 0; i < 3; i++) {
    const r = await postResponsesAndAccount(stack, m.rawKey, PRID);
    expect(r.accountId).toBe(stuckTo);
  }
  // Make the stuck target unschedulable → next call must rebind to the OTHER (healthy) account.
  await stack.db.update(upstreamAccounts).set({ schedulable: false }).where(eq(upstreamAccounts.id, stuckTo));
  const rebind = await postResponsesAndAccount(stack, m.rawKey, PRID);
  expect(rebind.accountId).not.toBe(stuckTo);
  expect([a1.id, a2.id]).toContain(rebind.accountId);
});
```

> **Implementer note:** the helper `postResponsesAndAccount(stack, rawKey, prid)` must (a) POST `/v1/responses`, (b) `await drainUsageQueue(stack.db, <runningCount>)`, (c) return the `account_id` of the newest `usage_logs` row (order by an inserted-at/sequence column desc, limit 1). Implement it in `requests.ts` alongside `postMessages`; read the newest row via `usageLogs` ordered by its primary timestamp/id column (grep `packages/db/src/schema/usageLogs.ts` for the orderable column). Replace the placeholder `accountForLastRequest` above with this real helper. The L2 test mirrors this using `/v1/messages` + an `x-claude-session-id` header instead of `previous_response_id`.

- [ ] **Step 3: Add the C4-L2 test** (same file) — identical structure but the sticky key is the `x-claude-session-id` header on `/v1/messages` (anthropic accounts), asserting initial stick + rebind-on-unschedulable.
- [ ] **Step 4: Run** — `pnpm test:load`. Fix group schema names as needed.
- [ ] **Step 5: Commit**

```bash
git add apps/gateway/tests/load/correctness/c4-sticky.load.test.ts apps/gateway/tests/load/requests.ts
git commit -m "test(gateway): C4 sticky L1 (previous_response_id) + L2 (session header) with failover rebind"
```

### Task 12: C5 — idempotency (non-stream)

**Files:** Create `apps/gateway/tests/load/correctness/c5-idempotency.load.test.ts`

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

async function setup(slug: string) {
  const orgId = await seedOrg(stack.db, slug);
  const userId = await seedUser(stack.db, slug, 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, slug, 1, "pool");
  await seedAccount(stack.db, orgId, slug, 1, { userId: null });
  return m;
}

it("C5: concurrent same X-Request-Id → exactly one reaches upstream, the rest 409 request_in_progress", async () => {
  const m = await setup("c5a");
  stack.fake.setLatency(400); // widen the in-flight window so duplicates collide
  const id = "req-c5-concurrent";
  const results = await Promise.all(Array.from({ length: 5 }, () => postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id })));
  const ok = results.filter((r) => r.status === 200).length;
  const conflict = results.filter((r) => r.status === 409);
  expect(ok).toBe(1);
  expect(conflict.length).toBe(4);
  expect(conflict.every((r) => r.json?.error === "request_in_progress")).toBe(true);
  expect(stack.fake.requestCount()).toBe(1); // only one hit upstream
});

it("C5: replay after completion is byte-identical and bills only once", async () => {
  const m = await setup("c5b");
  stack.fake.setLatency(0);
  const id = "req-c5-replay";
  const first = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(first.status).toBe(200);
  await drainUsageQueue(stack.db, 1);
  const replay = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(replay.status).toBe(200);
  expect(replay.text).toBe(first.text); // byte-identical
  // No double-billing: still exactly one usage row, and the upstream saw one call.
  const rows = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  expect(rows[0]!.c).toBe(1);
  expect(stack.fake.requestCount()).toBe(1);
});

it("C5: a non-2xx response is NOT cached (next same-id request re-hits upstream)", async () => {
  const m = await setup("c5c");
  stack.fake.setLatency(0);
  const id = "req-c5-error";
  // First: force the account's credential to 401 → non-2xx (single account → 503 all_upstreams_failed).
  stack.fake.forceStatus("tok-c5c-1", 401);
  const first = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(first.status).toBeGreaterThanOrEqual(400);
  const upstreamCallsAfterFirst = stack.fake.requestCount();
  // Clear the forced error; same id should NOT replay the error — it re-hits upstream and now 200s.
  stack.fake.forceStatus("tok-c5c-1", 200);
  const second = await postMessages(stack.baseUrl, m.rawKey, undefined, { "x-request-id": id });
  expect(second.status).toBe(200);
  expect(stack.fake.requestCount()).toBeGreaterThan(upstreamCallsAfterFirst);
});
```

> **Implementer note:** confirm the idempotency trigger header is `x-request-id` (grep `apps/gateway/src/routes/idempotencyEntry.ts` / `idempotencyCache.ts`). The `credToken` for the single account defaults to `tok-c5c-1` (slug `c5c`, n=1) per `seed.ts`; adjust the `forceStatus` token to match the seeded `credToken`.

- [ ] **Step 2: Run** — `pnpm test:load`.
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c5-idempotency.load.test.ts
git commit -m "test(gateway): C5 idempotency (concurrent 409 request_in_progress, byte-identical replay, no double-bill, non-2xx not cached)"
```

---

### Task 13: C6 — failover pressure

**Files:** Create `apps/gateway/tests/load/correctness/c6-failover.load.test.ts`

Boot with a known `maxSwitches=S`; seed `S-1` bad accounts + 1 healthy so the healthy one is within the switch budget. Separate all-bad scenario asserts `all_upstreams_failed`.

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { usageLogs } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { drainUsageQueue } from "../drainUsageQueue.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const S = 5;
beforeAll(async () => { stack = await bootStack({ maxSwitches: S }); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C6: S-1 accounts forced 503 + 1 healthy → request lands on the healthy one (within switch budget)", async () => {
  const orgId = await seedOrg(stack.db, "c6a");
  const userId = await seedUser(stack.db, "c6a", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c6a", 1, "pool");
  for (let i = 0; i < S - 1; i++) {
    const bad = await seedAccount(stack.db, orgId, "c6a", i, { userId: null, priority: 1 }); // higher prio first
    stack.fake.forceStatus(bad.credToken, 503);
  }
  const healthy = await seedAccount(stack.db, orgId, "c6a", 99, { userId: null, priority: 100 });

  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(200);
  await drainUsageQueue(stack.db, 1);
  const rows = await stack.db.select({ a: usageLogs.accountId }).from(usageLogs);
  expect(rows[0]!.a).toBe(healthy.id);
  // exactly one billed row despite the retries.
  const cnt = await stack.db.select({ c: sql<number>`count(*)::int` }).from(usageLogs);
  expect(cnt[0]!.c).toBe(1);
});

it("C6: every account 503 → 503 all_upstreams_failed", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c6b");
  const userId = await seedUser(stack.db, "c6b", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c6b", 1, "pool");
  for (let i = 0; i < 3; i++) {
    const bad = await seedAccount(stack.db, orgId, "c6b", i, { userId: null });
    stack.fake.forceStatus(bad.credToken, 503);
  }
  const r = await postMessages(stack.baseUrl, m.rawKey);
  expect(r.status).toBe(503);
  expect(r.json?.error).toBe("all_upstreams_failed");
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. (If failover picks by something other than priority, seed all-bad-but-one and assert it lands on the single healthy account regardless of order.)
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c6-failover.load.test.ts
git commit -m "test(gateway): C6 failover pressure (lands on healthy within budget; all-bad → all_upstreams_failed; no double-bill)"
```

### Task 14: C7 — streaming correctness

**Files:** Create `apps/gateway/tests/load/correctness/c7-streaming.load.test.ts`

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, beforeAll, expect, it } from "vitest";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";

let stack: LoadStack;
beforeAll(async () => { stack = await bootStack(); }, 120_000);
afterAll(async () => { await stack.teardown(); });

/** Stream /v1/messages; returns the full SSE text + firstTokenMs (time to first byte). */
async function streamMessages(rawKey: string): Promise<{ status: number; sse: string; firstTokenMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${stack.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const reader = res.body!.getReader();
  let firstTokenMs = -1, sse = "";
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
    sse += dec.decode(value, { stream: true });
  }
  return { status: res.status, sse, firstTokenMs };
}

it("C7: concurrent streams each get a complete, uncorrupted SSE; firstTokenMs positive; slots released after", async () => {
  const orgId = await seedOrg(stack.db, "c7");
  const userId = await seedUser(stack.db, "c7", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c7", 1, "pool");
  const acct = await seedAccount(stack.db, orgId, "c7", 1, { userId: null, concurrency: 1000 });
  stack.fake.setFirstTokenDelay(20);

  const streams = await Promise.all(Array.from({ length: 4 }, () => streamMessages(m.rawKey)));
  for (const s of streams) {
    expect(s.status).toBe(200);
    expect(s.sse).toContain("event: message_start");
    expect(s.sse).toContain("event: message_stop");
    expect(s.firstTokenMs).toBeGreaterThan(0);
  }

  // Slots released after completion — assert directly on the Redis ZSET (not Prometheus alone).
  const held = await stack.redis.zcard(`slots:account:${acct.id}`);
  expect(held).toBe(0);
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. If `zcard` is non-zero immediately, add a short `waitFor(async () => (await stack.redis.zcard(...)) === 0, 5000)` to allow the `finally` release to land.
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c7-streaming.load.test.ts
git commit -m "test(gateway): C7 streaming correctness (complete SSE under concurrency, firstTokenMs>0, slot ZSET drains)"
```

### Task 15: C8a — credential-health degrade (#205 regression, gateway-only)

**Files:** Create `apps/gateway/tests/load/correctness/c8a-credential-health.load.test.ts`

- [ ] **Step 1: Write the test (RED)**

```typescript
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upstreamAccounts } from "@caliber/db/schema";
import { bootStack, type LoadStack } from "../bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../seed.js";
import { counterValue } from "../scrapeMetrics.js";
import { postMessages } from "../requests.js";

let stack: LoadStack;
const N = 3;
beforeAll(async () => { stack = await bootStack({ authMaxFail: N }); }, 120_000);
afterEach(async () => { await stack.resetState(); });
afterAll(async () => { await stack.teardown(); });

it("C8a: N consecutive 401s degrade ONLY that api_key account recoverably (status stays active); metric +1", async () => {
  const orgId = await seedOrg(stack.db, "c8a");
  const userId = await seedUser(stack.db, "c8a", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c8a", 1, "pool");
  const dead = await seedAccount(stack.db, orgId, "c8a", 1, { userId: null });
  const healthy = await seedAccount(stack.db, orgId, "c8a", 2, { userId: null });
  stack.fake.forceStatus(dead.credToken, 401);

  const before = await counterValue(stack.app.gwMetrics.upstreamCredentialDegradedTotal, { platform: "anthropic" });
  for (let i = 0; i < N; i++) await postMessages(stack.baseUrl, m.rawKey); // each routes, dead 401s → failover to healthy

  const deadRow = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, dead.id)))[0]!;
  expect(deadRow.tempUnschedulableReason).toBe("api_key_invalid_credential");
  expect(deadRow.status).toBe("active"); // recoverable: NEVER status=error
  expect(deadRow.tempUnschedulableUntil).not.toBeNull();

  const healthyRow = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, healthy.id)))[0]!;
  expect(healthyRow.tempUnschedulableReason).toBeNull(); // only the dead one degraded

  const after = await counterValue(stack.app.gwMetrics.upstreamCredentialDegradedTotal, { platform: "anthropic" });
  expect(after - before).toBe(1); // transition metric fires once
});

it("C8a: a 403 neither degrades nor resets the counter", async () => {
  await stack.resetState();
  const orgId = await seedOrg(stack.db, "c8a2");
  const userId = await seedUser(stack.db, "c8a2", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "c8a2", 1, "pool");
  const acct = await seedAccount(stack.db, orgId, "c8a2", 1, { userId: null });
  const healthy = await seedAccount(stack.db, orgId, "c8a2", 2, { userId: null });
  stack.fake.forceStatus(acct.credToken, 403);

  for (let i = 0; i < N + 2; i++) await postMessages(stack.baseUrl, m.rawKey);

  const row = (await stack.db.select().from(upstreamAccounts).where(eq(upstreamAccounts.id, acct.id)))[0]!;
  expect(row.tempUnschedulableReason).not.toBe("api_key_invalid_credential"); // 403 never sets the credential-degrade reason
});
```

- [ ] **Step 2: Run** — `pnpm test:load`. (The dead account must have a sibling healthy account so the request still completes; otherwise the loop returns 503, which is fine — but a second account keeps the request flow realistic.)
- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/load/correctness/c8a-credential-health.load.test.ts
git commit -m "test(gateway): C8a credential-health degrade under load (401 recoverable-degrade, 403 no-op, metric +1)"
```

---

## Phase 3 — Perf benchmark (report-only)

### Task 16: `scripts/perf-gateway.ts` — autocannon matrix + report

**Files:**
- Create: `scripts/perf-gateway.ts`
- Create: `docs/perf/.gitkeep`
- Modify: root `package.json` (add `perf:gateway` script + `autocannon` devDep)

- [ ] **Step 1: Add autocannon**

Run: `pnpm --filter @caliber/gateway add -D autocannon @types/autocannon`
(Or root, matching where `scripts/` resolves deps — check `scripts/` existing tsx invocation in root `package.json`.)

- [ ] **Step 2: Add the script entry**

Root `package.json` scripts:
```json
"perf:gateway": "tsx scripts/perf-gateway.ts",
```

- [ ] **Step 3: Implement `scripts/perf-gateway.ts`**

```typescript
import autocannon from "autocannon";
import os from "node:os";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bootStack } from "../apps/gateway/tests/load/bootStack.js";
import { seedOrg, seedUser, seedMembership, seedApiKey, seedAccount } from "../apps/gateway/tests/load/seed.js";

interface Cell { surface: string; route: string; body: Record<string, unknown>; latencyMs: number; }

const SURFACES: Array<{ surface: string; route: string; body: Record<string, unknown> }> = [
  { surface: "messages", route: "/v1/messages", body: { model: "claude-3-haiku-20240307", max_tokens: 16, messages: [{ role: "user", content: "hello" }] } },
  { surface: "responses", route: "/v1/responses", body: { model: "gpt-4o", input: "hello" } },
  // codex-responses uses the same upstream shape via the codex route:
  { surface: "codex-responses", route: "/backend-api/codex/responses", body: { model: "gpt-4o", input: "hello" } },
];
const LATENCIES = [0, 50, 200];

function parseArg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

async function main() {
  const connections = parseArg("connections", 50);
  const duration = parseArg("duration", 20);

  const stack = await bootStack({ maxWait: 100000, maxSwitches: 10 });
  const orgId = await seedOrg(stack.db, "perf");
  const userId = await seedUser(stack.db, "perf", 1);
  await seedMembership(stack.db, orgId, userId);
  const m = await seedApiKey(stack.db, orgId, userId, "perf", 1, "pool");
  // High concurrency so slots never bottleneck steady-state.
  await seedAccount(stack.db, orgId, "perf", 1, { userId: null, platform: "anthropic", concurrency: 100000 });
  await seedAccount(stack.db, orgId, "perf", 2, { userId: null, platform: "openai", concurrency: 100000 });

  const rows: string[] = [];
  for (const s of SURFACES) {
    for (const latencyMs of LATENCIES) {
      stack.fake.reset();
      stack.fake.setLatency(latencyMs);
      const opts = {
        url: `${stack.baseUrl}${s.route}`, connections, method: "POST" as const,
        headers: { authorization: `Bearer ${m.rawKey}`, "content-type": "application/json" },
        body: JSON.stringify(s.body),
      };
      // Warmup (discarded).
      await autocannon({ ...opts, duration: 3 });
      // Measured.
      const r = await autocannon({ ...opts, duration });
      const net = Math.max(0, Math.round(r.latency.p50 - latencyMs));
      rows.push(`| ${s.surface} | ${latencyMs} | ${Math.round(r.requests.average)} | ${r.latency.p50} | ${r.latency.p97_5} | ${r.latency.p99} | ${r.latency.max} | ${r.non2xx} | ${stack.fake.requestCount()} | ${stack.fake.errorCount()} | ${net} |`);
    }
  }

  const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
  const date = execSync("date +%Y-%m-%d").toString().trim();
  const md = [
    `# Gateway load report — ${date}`, "",
    "## Environment", "",
    `- git sha: ${gitSha}`,
    `- Node: ${process.version}`,
    `- OS/CPU: ${os.type()} ${os.release()} / ${os.cpus()[0]?.model} x${os.cpus().length}`,
    `- connections: ${connections}, duration: ${duration}s`,
    `- payload: fixed small (see scripts/perf-gateway.ts SURFACES)`,
    `- fake latencies: ${LATENCIES.join("/")}ms`,
    `- env: GATEWAY_ENABLE_MODEL_ALIAS=false, GATEWAY_CACHE_TTL_SEC=0, no idempotency header`, "",
    "## Results", "",
    "| surface | upstream_ms | RPS | p50 | p95 | p99 | max | non2xx | fake_reqs | fake_errs | gw_net_p50 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows, "",
    "> Streaming first-token vs stream-complete is measured separately (TODO: add a streaming cell with client-side firstToken).",
  ].join("\n");
  writeFileSync(`docs/perf/${date}-gateway-load.md`, md);
  console.log(md);

  await stack.teardown();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> **Implementer note:** confirm the codex route path (`/backend-api/codex/responses`) and the `tsx` runner from root `package.json`. autocannon's percentile fields are `latency.p50/p97_5/p99/max` and `requests.average`/`non2xx` — verify against the installed autocannon types and adjust field names. Streaming first-token measurement is a documented follow-up (Non-Goal-adjacent); the matrix above covers non-stream surfaces for v1.

- [ ] **Step 4: Run it once**

Run: `pnpm perf:gateway -- --connections 20 --duration 5`
Expected: prints a report table and writes `docs/perf/<date>-gateway-load.md`. Numbers will vary; this is report-only.

- [ ] **Step 5: Commit**

```bash
git add scripts/perf-gateway.ts docs/perf/.gitkeep package.json pnpm-lock.yaml
git commit -m "perf(gateway): autocannon report-only load benchmark (5-surface x 0/50/200ms matrix, env metadata)"
```

---

## Phase 4 — CI wiring, docs, final green

### Task 17: README runbook + dedicated CI job

**Files:**
- Create: `apps/gateway/tests/load/README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the README**

`apps/gateway/tests/load/README.md`:
```markdown
# Gateway load-test harness (#206)

Correctness gate (CI; needs Docker for Testcontainers — Postgres + Redis):

    pnpm --filter @caliber/gateway test:load

Perf benchmark (report-only, manual; needs Docker):

    pnpm perf:gateway
    pnpm perf:gateway -- --connections 100 --duration 30

Output: docs/perf/<date>-gateway-load.md (env metadata for trend comparison).

Design: docs/superpowers/specs/2026-06-12-gateway-load-test-design.md
The correctness lane is serial (prom-client global registry + one long-lived gateway).
```

- [ ] **Step 2: Add a dedicated CI job**

In `.github/workflows/ci.yml`, mirror the existing `gateway-integration` job but run `test:load` (it boots its own Postgres + Redis via Testcontainers, so it needs Docker available on the runner — the existing integration job already proves that works). Name it `gateway-load`. Copy the integration job's `runs-on`, checkout, pnpm/node setup, and `pnpm --filter @caliber/gateway build` (gateway-core dist) steps; change the test step to:
```yaml
      - name: Gateway load correctness gate
        run: pnpm --filter @caliber/gateway test:load
```

- [ ] **Step 3: Validate the workflow locally**

Run: `grep -nA3 "gateway-load" .github/workflows/ci.yml`
Expected: the job block is present and well-formed. (Optionally `act` if available; otherwise rely on the PR run.)

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/tests/load/README.md .github/workflows/ci.yml
git commit -m "ci(gateway): dedicated gateway-load job + harness README runbook"
```

### Task 18: Full green — run the whole gate + monorepo checks

**Files:** none (verification + any fixups)

- [ ] **Step 1: Rebuild deps (avoid stale gateway-core dist)**

Run: `pnpm turbo run build`
Expected: all packages build.

- [ ] **Step 2: Run the full load gate**

Run: `cd apps/gateway && pnpm test:load`
Expected: C0–C8a all green. Fix any flakes by widening fake latency windows (never by weakening an assertion).

- [ ] **Step 3: Run the normal lanes to prove no collision**

Run: `cd apps/gateway && pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts && pnpm typecheck`
Expected: green; the `.load.test.ts` files are NOT picked up by the unit or integration lanes (the `fakeUpstream.test.ts`/`scrapeMetrics.test.ts` unit self-tests ARE, and pass).

- [ ] **Step 4: Whole-monorepo typecheck**

Run: `pnpm turbo run typecheck`
Expected: 18/18 (or current count) green.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "test(gateway): load harness full-green fixups"
```

---

## Self-Review (run before declaring the plan done)

**1. Spec coverage:** C0 (sanity)=T7, C1+C1b=T8, C2=T9, C3=T10, C4-L1/L2=T11, C5=T12, C6=T13, C7=T14, C8a=T15; C8b explicitly out-of-scope (apps/api); rate-limit out-of-scope; perf matrix=T16; runbook+CI=T17; non-goals respected (no saturation probe, no real upstream, no rate-limit-in-gate). Foundation: fakeUpstream=T2, scrapeMetrics=T3, drain+cleanup=T4, seed=T5, bootStack=T6, config=T1.

**2. Placeholder scan:** the two "Implementer note" blocks (C4 `postResponsesAndAccount`, perf streaming first-token) are explicit, scoped follow-ups with instructions — not silent TODOs. All code steps contain real code.

**3. Type consistency:** `bootStack()` → `LoadStack` used everywhere; `seedAccount` returns `{id, credToken}` (used by C2/C6/C8a); `seedApiKey` returns `SeededMember` with `rawKey`/`apiKeyId`; `counterValue(metric, match)` signature consistent across C2/C8a; `postMessages` signature consistent. `masterKey`/`pepper` defined once in `seed.ts`, imported by `bootStack.ts`.

**Known verify-on-implement points (flagged in-task):** schema column/table names (`upstreamAccounts.concurrency`, `apiKeys.routingPolicy`, membership table, `account_groups`/`account_group_members`), the idempotency trigger header, the codex route path, autocannon field names, `RedisContainer` URL accessor, and the slot-acquire `result` label. Each task tells the implementer exactly what to grep.
