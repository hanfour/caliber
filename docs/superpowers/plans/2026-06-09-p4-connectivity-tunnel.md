# P4 — 連線模型（Cloudflare Tunnel）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 BYOK 用戶無需各自裝 VPN 即可連到 gateway（Cloudflare named tunnel），並補上公開暴露需要的兩塊硬化：每 IP 認證失敗節流 + org 預算 webhook 告警。

**Architecture:** 三塊獨立但內聚 + docs。① cloudflared compose 服務（`--profile tunnel`，專屬 `tunnel` network、origin alias `gateway-tunnel`）。② gateway middleware：`resolveClientIp`（socket-peer 驗證後才採信 `CF-Connecting-IP`）+ Redis-backed `ipAuthThrottle`，接進 `apiKeyAuth` 的認證失敗分支（有效 key 永不節流）。③ `budgetAlertWebhook`（掛 `wrapEnforceBudget` 的 warn/exceeded，send-then-mark 去重、fire-and-forget）。零 schema / 零 migration。

**Tech Stack:** Fastify gateway、ioredis、Zod（@caliber/config）、prom-client metrics、Docker Compose、Vitest（gateway 單元/整合，fake redis = ioredis-mock）。

**Spec:** `docs/superpowers/specs/2026-06-09-p4-connectivity-tunnel-design.md`

---

## File Structure

| 檔案 | 職責 | 動作 |
|------|------|------|
| `packages/config/src/env.ts` | 5 個新 env（TUNNEL_TOKEN / GATEWAY_ALERT_WEBHOOK_URL / GATEWAY_AUTH_FAIL_MAX/WINDOW_SEC/BLOCK_SEC） | Modify |
| `apps/gateway/src/middleware/resolveClientIp.ts` | socket-peer 驗證後採信 CF-Connecting-IP，否則 req.ip | Create |
| `apps/gateway/src/redis/ipAuthThrottle.ts` | `checkIpBlocked` / `recordAuthFailure`（Redis 計數 + 封鎖） | Create |
| `apps/gateway/src/plugins/metrics.ts` | 新 counter `gwAuthFailThrottleTotal` | Modify |
| `apps/gateway/src/middleware/apiKeyAuth.ts` | 接 `resolveClientIp` + 節流；認證失敗統一走 throttle | Modify |
| `apps/gateway/src/server.ts` | apiKeyAuthPlugin opts 加節流 cfg（從 env 解析） | Modify |
| `apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts` | `maybeSendBudgetAlert`（send-then-mark 去重 + fire-and-forget POST） | Create |
| `apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts` | `wrapEnforceBudget` 加可選 `onBudgetEvent` 回呼 | Modify |
| `apps/gateway/src/workers/evaluator/runFacetExtraction.ts` | 構造 alert sink 傳入 wrapEnforceBudget | Modify |
| `docker/docker-compose.yml` | `cloudflared` 服務 + `tunnel` network + gateway 接 tunnel/alias | Modify |
| `docs/GATEWAY.md` 或新 runbook | tunnel 建置 + key 衛生 + 節流 env + webhook 格式 | Modify |

**執行順序：** 1（env）→ 2（resolveClientIp）→ 3（ipAuthThrottle）→ 4（metrics）→ 5（apiKeyAuth 接線）→ 6（budgetAlertWebhook）→ 7（wrapEnforceBudget 接線）→ 8（compose）→ 9（docs）。

---

## Task 1: config — 5 個新 env

**Files:**
- Modify: `packages/config/src/env.ts`
- Test: `packages/config/tests/env.p4.test.ts`（新）

- [ ] **Step 1: 在 `serverEnvSchema` 加欄位**

於 `packages/config/src/env.ts` 的 `serverEnvSchema` 內，緊接 `GATEWAY_TRUSTED_PROXIES` 之後加：

```ts
  TUNNEL_TOKEN: emptyAsUndefined(z.string().optional()),
  GATEWAY_ALERT_WEBHOOK_URL: emptyAsUndefined(z.string().url().optional()),
  GATEWAY_AUTH_FAIL_MAX: emptyAsUndefined(z.coerce.number().int().min(0).default(10)),
  GATEWAY_AUTH_FAIL_WINDOW_SEC: emptyAsUndefined(z.coerce.number().int().min(0).default(300)),
  GATEWAY_AUTH_FAIL_BLOCK_SEC: emptyAsUndefined(z.coerce.number().int().min(0).default(900)),
```

（`emptyAsUndefined`/`z.coerce.number` 皆為該檔既有 helper/用法；若 `z.coerce.number().default()` 與 `emptyAsUndefined` 組合在其他欄位已有先例，照抄該樣式。）

- [ ] **Step 2: 寫測試**

`packages/config/tests/env.p4.test.ts`（沿用既有 `env.oauth.test.ts` 的 `parseServerEnv(valid)` baseline fixture — 先 `grep -rn "parseServerEnv\|const valid" packages/config/tests` 找既有 fixture 並 import/複製）：

```ts
import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env.js";
// reuse the baseline `valid` fixture from env.test.ts (required fields)
import { valid } from "./fixtures.js"; // if no shared fixture, inline the baseline from env.test.ts

describe("serverEnv P4 connectivity", () => {
  it("defaults: tunnel/webhook undefined, throttle 10/300/900", () => {
    const env = parseServerEnv(valid);
    expect(env.TUNNEL_TOKEN).toBeUndefined();
    expect(env.GATEWAY_ALERT_WEBHOOK_URL).toBeUndefined();
    expect(env.GATEWAY_AUTH_FAIL_MAX).toBe(10);
    expect(env.GATEWAY_AUTH_FAIL_WINDOW_SEC).toBe(300);
    expect(env.GATEWAY_AUTH_FAIL_BLOCK_SEC).toBe(900);
  });
  it("parses overrides + rejects bad webhook url", () => {
    const env = parseServerEnv({ ...valid, GATEWAY_AUTH_FAIL_MAX: "5", GATEWAY_ALERT_WEBHOOK_URL: "https://hooks.example/x" });
    expect(env.GATEWAY_AUTH_FAIL_MAX).toBe(5);
    expect(env.GATEWAY_ALERT_WEBHOOK_URL).toBe("https://hooks.example/x");
    expect(() => parseServerEnv({ ...valid, GATEWAY_ALERT_WEBHOOK_URL: "not-a-url" })).toThrow();
  });
});
```

> 若 `tests/fixtures.js` 不存在，直接在測試檔內聯既有 `env.test.ts` 的 baseline `valid` 物件（含所有 required 欄位）。

- [ ] **Step 3: 跑測試** — `pnpm --filter @caliber/config test` → PASS。`pnpm --filter @caliber/config typecheck` → clean。

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/env.ts packages/config/tests/env.p4.test.ts
git commit -m "feat(config): P4 connectivity env (tunnel token, alert webhook, auth-fail throttle)"
```

---

## Task 2: gateway — resolveClientIp（socket-peer 驗證）

**Files:**
- Create: `apps/gateway/src/middleware/resolveClientIp.ts`
- Test: `apps/gateway/tests/middleware/resolveClientIp.test.ts`

- [ ] **Step 1: 寫失敗測試**

`apps/gateway/tests/middleware/resolveClientIp.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveClientIp } from "../../src/middleware/resolveClientIp.js";

// Minimal FastifyRequest-shaped stub for the fields resolveClientIp reads.
function req(opts: { ip: string; peer: string; cfHeader?: string }) {
  return {
    ip: opts.ip,
    headers: opts.cfHeader ? { "cf-connecting-ip": opts.cfHeader } : {},
    raw: { socket: { remoteAddress: opts.peer } },
  } as unknown as import("fastify").FastifyRequest;
}

describe("resolveClientIp", () => {
  it("trusts CF-Connecting-IP when the socket peer is a trusted proxy", () => {
    const ip = resolveClientIp(req({ ip: "10.9.0.2", peer: "10.9.0.2", cfHeader: "203.0.113.7" }), ["10.9.0.0/24"]);
    expect(ip).toBe("203.0.113.7");
  });
  it("IGNORES CF-Connecting-IP when the socket peer is NOT trusted (spoof)", () => {
    const ip = resolveClientIp(req({ ip: "192.168.1.50", peer: "192.168.1.50", cfHeader: "203.0.113.7" }), ["10.9.0.0/24"]);
    expect(ip).toBe("192.168.1.50");
  });
  it("falls back to req.ip when trusted peer sends no CF header", () => {
    expect(resolveClientIp(req({ ip: "203.0.113.9", peer: "10.9.0.2" }), ["10.9.0.0/24"])).toBe("203.0.113.9");
  });
  it("empty trustedProxies → always req.ip (never trusts header)", () => {
    expect(resolveClientIp(req({ ip: "1.2.3.4", peer: "10.9.0.2", cfHeader: "203.0.113.7" }), [])).toBe("1.2.3.4");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway test -- resolveClientIp` → FAIL（模組不存在）。

- [ ] **Step 3: 實作**

`apps/gateway/src/middleware/resolveClientIp.ts`：

```ts
import ipaddr from "ipaddr.js";
import type { FastifyRequest } from "fastify";

// CF-Connecting-IP is the single authoritative client IP that Cloudflare sets
// on the trusted hop. But the gateway also publishes :3002 directly, so a
// LAN/VPN/direct client can FORGE this header. We therefore only honour it
// when the socket peer (the actual TCP source) is one of the configured
// trusted proxies (the cloudflared peer / tunnel network). Otherwise we
// ignore the header entirely and fall back to Fastify's resolved req.ip.
export function resolveClientIp(
  req: FastifyRequest,
  trustedProxies: string[],
): string {
  if (trustedProxies.length === 0) return req.ip;
  const peer = req.raw.socket.remoteAddress ?? "";
  if (!peerIsTrusted(peer, trustedProxies)) return req.ip;
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim().length > 0) return cf.trim();
  return req.ip;
}

function peerIsTrusted(peer: string, cidrs: string[]): boolean {
  if (!peer) return false;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(peer);
  } catch {
    return false;
  }
  return cidrs.some((c) => {
    try {
      const cidr = c.includes("/")
        ? c
        : `${c}/${parsed.kind() === "ipv6" ? 128 : 32}`;
      return parsed.match(ipaddr.parseCIDR(cidr));
    } catch {
      return false;
    }
  });
}
```

- [ ] **Step 4: 跑測試** — `pnpm --filter @caliber/gateway test -- resolveClientIp` → PASS（4/4）。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/middleware/resolveClientIp.ts apps/gateway/tests/middleware/resolveClientIp.test.ts
git commit -m "feat(gateway): resolveClientIp — honour CF-Connecting-IP only from trusted socket peers"
```

---

## Task 3: gateway — ipAuthThrottle（Redis 計數 + 封鎖）

**Files:**
- Create: `apps/gateway/src/redis/ipAuthThrottle.ts`
- Test: `apps/gateway/tests/redis/ipAuthThrottle.test.ts`

> 比照既有 `apps/gateway/src/redis/rateLimit.js` 的 Redis-helper 樣式。測試用 `ioredis-mock`（既有 redis 測試已用此）。

- [ ] **Step 1: 寫失敗測試**

`apps/gateway/tests/redis/ipAuthThrottle.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { checkIpBlocked, recordAuthFailure } from "../../src/redis/ipAuthThrottle.js";

const CFG = { max: 3, windowSec: 60, blockSec: 120 };

describe("ipAuthThrottle", () => {
  let redis: any;
  beforeEach(() => { redis = new RedisMock(); });

  it("not blocked before threshold", async () => {
    await recordAuthFailure(redis, "1.1.1.1", CFG);
    await recordAuthFailure(redis, "1.1.1.1", CFG);
    expect((await checkIpBlocked(redis, "1.1.1.1")).blocked).toBe(false);
  });

  it("blocks at threshold and reports retryAfterSec", async () => {
    let r;
    for (let i = 0; i < CFG.max; i++) r = await recordAuthFailure(redis, "2.2.2.2", CFG);
    expect(r!.justBlocked).toBe(true);
    const c = await checkIpBlocked(redis, "2.2.2.2");
    expect(c.blocked).toBe(true);
    expect(c.retryAfterSec).toBeGreaterThan(0);
    expect(c.retryAfterSec).toBeLessThanOrEqual(CFG.blockSec);
  });

  it("max=0 disables (never blocks)", async () => {
    const r = await recordAuthFailure(redis, "3.3.3.3", { ...CFG, max: 0 });
    expect(r.justBlocked).toBe(false);
    expect((await checkIpBlocked(redis, "3.3.3.3")).blocked).toBe(false);
  });

  it("distinct IPs counted separately", async () => {
    for (let i = 0; i < CFG.max; i++) await recordAuthFailure(redis, "4.4.4.4", CFG);
    expect((await checkIpBlocked(redis, "5.5.5.5")).blocked).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway test -- ipAuthThrottle` → FAIL。

- [ ] **Step 3: 實作**

`apps/gateway/src/redis/ipAuthThrottle.ts`：

```ts
import type { Redis } from "ioredis";

// Per-IP auth-failure brute-force throttle (spec §4.2). Two keys:
//   auth-fail:<ip>        — sliding count of recent auth failures (window TTL)
//   auth-fail-block:<ip>  — present => the IP is blocked (block TTL)
// Both live under the ioredis keyPrefix (caliber:gw:) configured on the client.

export interface AuthThrottleConfig {
  max: number; // failures within the window that trigger a block; 0 disables
  windowSec: number;
  blockSec: number;
}

const failKey = (ip: string) => `auth-fail:${ip}`;
const blockKey = (ip: string) => `auth-fail-block:${ip}`;

export interface BlockedState {
  blocked: boolean;
  retryAfterSec: number;
}

// Is this IP currently blocked? retryAfterSec = remaining block TTL.
export async function checkIpBlocked(
  redis: Redis,
  ip: string,
): Promise<BlockedState> {
  const ttl = await redis.ttl(blockKey(ip));
  if (ttl > 0) return { blocked: true, retryAfterSec: ttl };
  return { blocked: false, retryAfterSec: 0 };
}

export interface RecordResult {
  justBlocked: boolean;
  retryAfterSec: number;
}

// Record one auth failure for this IP. When the count crosses `max`, set the
// block key (blockSec TTL) and report justBlocked. max=0 disables entirely.
export async function recordAuthFailure(
  redis: Redis,
  ip: string,
  cfg: AuthThrottleConfig,
): Promise<RecordResult> {
  if (cfg.max <= 0) return { justBlocked: false, retryAfterSec: 0 };
  const k = failKey(ip);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, cfg.windowSec);
  if (count >= cfg.max) {
    await redis.set(blockKey(ip), "1", "EX", cfg.blockSec);
    return { justBlocked: true, retryAfterSec: cfg.blockSec };
  }
  return { justBlocked: false, retryAfterSec: 0 };
}
```

- [ ] **Step 4: 跑測試** — `pnpm --filter @caliber/gateway test -- ipAuthThrottle` → PASS（4/4）。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/redis/ipAuthThrottle.ts apps/gateway/tests/redis/ipAuthThrottle.test.ts
git commit -m "feat(gateway): ipAuthThrottle — Redis per-IP auth-failure counter + block"
```

---

## Task 4: gateway — gwAuthFailThrottleTotal metric

**Files:**
- Modify: `apps/gateway/src/plugins/metrics.ts`

- [ ] **Step 1: 在 `GatewayMetrics` interface 加欄位**

在 `apps/gateway/src/plugins/metrics.ts` 的 `GatewayMetrics` interface（`gwRateLimitFailOpenTotal: Counter<string>;` 附近）加：

```ts
  gwAuthFailThrottleTotal: Counter<string>;
```

- [ ] **Step 2: 建 counter（比照 `gwRateLimitFailOpenTotal`）**

在建立 `gwRateLimitFailOpenTotal` 的 `new Counter({...})` 之後加：

```ts
  const gwAuthFailThrottleTotal = new Counter({
    name: "gw_auth_fail_throttle_total",
    help: "Auth failures that were rate-limited (429) by the per-IP brute-force throttle",
    registers: [registry],
  });
```

（`registry` 變數名沿用該檔既有 counter 建構時用的 register 參數；若該檔用 `registers: [registry]` 以外的寫法，照抄鄰近 counter 的寫法。）

- [ ] **Step 3: 加進 decorate 物件**

在 `fastify.decorate("gwMetrics", { ... })` 物件內（`gwRateLimitFailOpenTotal,` 附近）加 `gwAuthFailThrottleTotal,`。並比照既有 `gwRateLimitFailOpenTotal.inc(0)` 的 0-初始化（若有）加 `gwAuthFailThrottleTotal.inc(0);`。

- [ ] **Step 4: 跑 gateway 既有 metrics 測試 + typecheck**

Run: `pnpm --filter @caliber/gateway test -- metrics && pnpm --filter @caliber/gateway typecheck`
Expected: PASS / clean（新 counter 不破壞既有測試）。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/plugins/metrics.ts
git commit -m "feat(gateway): gw_auth_fail_throttle_total metric"
```

---

## Task 5: gateway — apiKeyAuth 接 resolveClientIp + 節流

**Files:**
- Modify: `apps/gateway/src/middleware/apiKeyAuth.ts`
- Test: `apps/gateway/tests/middleware/apiKeyAuth.throttle.test.ts`（新；比照既有 apiKeyAuth 測試的 buildServer/inject 樣式）

> apiKeyAuthPlugin 在 `server.ts:163` 註冊於 `redisPlugin`（161）之後，故 `fastify.redis` + `fastify.gwMetrics` 在此可用。認證失敗一律走 `failAuth`（先查 blocked → 否則 record → 跨門檻則 429；Redis 錯 fail-open 回原錯）。**有效 key（狀態有效 ∧ 通過 IP policy）永不呼叫 failAuth**。

- [ ] **Step 1: 寫失敗測試（throttle 整合）**

`apps/gateway/tests/middleware/apiKeyAuth.throttle.test.ts`（先 `grep -rn "buildServer\|apiKeyAuth" apps/gateway/tests` 看既有 apiKeyAuth 測試怎麼起 server + 注入 ioredis-mock + seed 一把有效 key；複製其 harness）：

```ts
// 用既有 apiKeyAuth 測試 harness（buildServer + ioredis-mock redis 注入 + seed 一把有效 key）。
// 關鍵斷言：
// 1. 同一 IP 連送無效 key（X-Forwarded-For / 直接）達 GATEWAY_AUTH_FAIL_MAX 次後，下一個無效 key → 429 + retry-after。
// 2. 達門檻後，從「同一 IP」送『有效 key』仍 200（INV-P1：valid 不受節流）。
// 3. 無 key header 計入節流（不打 DB — 可用 spy on fastify.db.select 斷言未被呼叫，或省略此細節僅斷言 429）。
// 4. Redis 故障（注入會丟錯的 fake）→ 無效 key 仍回原 401（fail-open，不誤 429）。
// 設 env：GATEWAY_AUTH_FAIL_MAX=3, WINDOW_SEC=60, BLOCK_SEC=120；GATEWAY_TRUSTED_PROXIES 設成測試 socket peer 的網段，讓 X-Forwarded-For 生效（或直接用 req.ip 路徑）。
```

> 具體 inject 寫法依既有 apiKeyAuth 測試（用 `app.inject({ method, url:"/v1/messages", headers:{ "x-api-key": "<bad>" } })`，連打 MAX 次後第 MAX+1 次斷言 `res.statusCode===429` 且 `res.headers["retry-after"]`）。有效 key 用既有 seed 出的 key。

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway test -- apiKeyAuth.throttle` → FAIL（目前無效 key 回 401，不會 429）。

- [ ] **Step 3: 改 apiKeyAuth.ts**

(a) imports 加：

```ts
import { resolveClientIp } from "./resolveClientIp.js";
import {
  checkIpBlocked,
  recordAuthFailure,
  type AuthThrottleConfig,
} from "../redis/ipAuthThrottle.js";
```

(b) `pluginBody` 開頭（`fastify.decorateRequest(...)` 之後、`addHook` 之前）解析一次 cfg + trustedProxies：

```ts
  const throttleCfg: AuthThrottleConfig = {
    max: opts.env.GATEWAY_AUTH_FAIL_MAX,
    windowSec: opts.env.GATEWAY_AUTH_FAIL_WINDOW_SEC,
    blockSec: opts.env.GATEWAY_AUTH_FAIL_BLOCK_SEC,
  };
  const trustedProxies = opts.env.GATEWAY_TRUSTED_PROXIES.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Centralised auth-failure handler: runs the per-IP brute-force throttle
  // (Redis), returns 429 when blocked/just-blocked, else the original error.
  // Fail-open on Redis errors (availability > brute-force defence).
  async function failAuth(
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    ip: string,
    status: number,
    errCode: string,
  ): Promise<import("fastify").FastifyReply> {
    if (throttleCfg.max <= 0) {
      // throttle disabled → no Redis work, original error verbatim
      return reply.code(status).send({ error: errCode });
    }
    try {
      const blocked = await checkIpBlocked(fastify.redis, ip);
      if (blocked.blocked) {
        fastify.gwMetrics?.gwAuthFailThrottleTotal.inc();
        return reply
          .code(429)
          .header("retry-after", String(blocked.retryAfterSec))
          .send({ error: "rate_limited" });
      }
      const rec = await recordAuthFailure(fastify.redis, ip, throttleCfg);
      if (rec.justBlocked) {
        fastify.gwMetrics?.gwAuthFailThrottleTotal.inc();
        return reply
          .code(429)
          .header("retry-after", String(rec.retryAfterSec))
          .send({ error: "rate_limited" });
      }
    } catch (err) {
      req.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auth_throttle_check_failed",
      );
      fastify.gwMetrics?.redisErrorTotal.inc({ op: "auth_throttle" });
      // fail-open → fall through to the original error below
    }
    return reply.code(status).send({ error: errCode });
  }
```

> `fastify.redis` 為 redisPlugin decorate 的 Redis（恆存在；測試亦注入 ioredis-mock）。`failAuth` 開頭的 `throttleCfg.max <= 0` 守衛讓「停用節流」時完全不碰 Redis（直接回原錯）；`recordAuthFailure` 內部也有同樣短路作為第二層保險。

(c) 在 `addHook("preHandler", ...)` 內，於 `PUBLIC_PATHS` 檢查之後、`extractKey` 之前，計算真實 IP：

```ts
    const ip = resolveClientIp(req, trustedProxies);
```

(d) 把每個認證失敗分支改成走 `failAuth`：
- `if (!raw) { return failAuth(req, reply, ip, 401, "missing_api_key"); }`（pre-DB；不查 DB）
- `if (!row) { return failAuth(req, reply, ip, 401, "key_invalid"); }`
- `key_revoked` → `return failAuth(req, reply, ip, 401, "key_revoked");`
- `key_expired` → `return failAuth(req, reply, ip, 401, "key_expired");`
- `key_not_yet_revealed` → `return failAuth(req, reply, ip, 401, "key_not_yet_revealed");`
- 兩處 `ip_not_allowed` → `return failAuth(req, reply, ip, 403, "ip_not_allowed");`

（`server_misconfigured`(500) 與成功路徑不變。**刪掉**原本 `const ip = req.ip;` 那行 —上面 (c) 已用 `resolveClientIp` 取代；IP policy 的 `matchesAny(ip, ...)` 改用此 `ip`。）

- [ ] **Step 4: 跑測試 + 既有 apiKeyAuth 測試無回歸**

Run: `pnpm --filter @caliber/gateway test -- apiKeyAuth && pnpm --filter @caliber/gateway typecheck`
Expected: PASS（新 throttle 測試 + 既有 apiKeyAuth 測試全綠；型別乾淨）。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/middleware/apiKeyAuth.ts apps/gateway/tests/middleware/apiKeyAuth.throttle.test.ts
git commit -m "feat(gateway): per-IP auth-failure throttle in apiKeyAuth (valid keys unaffected; real client IP)"
```

---

## Task 6: gateway — budgetAlertWebhook（send-then-mark 去重）

**Files:**
- Create: `apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts`
- Test: `apps/gateway/tests/workers/budgetAlertWebhook.test.ts`

- [ ] **Step 1: 寫失敗測試**

`apps/gateway/tests/workers/budgetAlertWebhook.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { maybeSendBudgetAlert } from "../../src/workers/evaluator/budgetAlertWebhook.js";

const noopLog = { warn: () => {} } as any;
function deps(over: Partial<{ redis: any; fetch: any; webhookUrl?: string; now: () => Date }> = {}) {
  return {
    redis: over.redis ?? new RedisMock(),
    fetch: over.fetch ?? vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    webhookUrl: "webhookUrl" in over ? over.webhookUrl : "https://hooks.example/x",
    logger: noopLog,
    now: over.now ?? (() => new Date("2026-06-09T00:00:00Z")),
  };
}
const evt = { orgId: "o1", event: "warn" as const, monthToDate: "9.0", budget: "10.0" };

describe("maybeSendBudgetAlert", () => {
  it("POSTs once on 2xx + writes dedup key", async () => {
    const d = deps();
    await maybeSendBudgetAlert(d, evt);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(await d.redis.get("alert-sent:warn:o1:2026-06")).toBe("1");
    const body = JSON.parse(d.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ event: "warn", orgId: "o1" });
    expect(JSON.stringify(body)).not.toMatch(/ak_|token|secret/i);
  });
  it("deduped: second same-month warn does not POST", async () => {
    const redis = new RedisMock();
    const d1 = deps({ redis }); await maybeSendBudgetAlert(d1, evt);
    const d2 = deps({ redis }); await maybeSendBudgetAlert(d2, evt);
    expect(d2.fetch).not.toHaveBeenCalled();
  });
  it("no webhook url → no POST, no throw", async () => {
    const d = deps({ webhookUrl: undefined });
    await maybeSendBudgetAlert(d, evt);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("non-2xx → does NOT write dedup (retried next time), no throw", async () => {
    const redis = new RedisMock();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await maybeSendBudgetAlert(deps({ redis, fetch }), evt);
    expect(await redis.get("alert-sent:warn:o1:2026-06")).toBeNull();
  });
  it("exceeded dedup key includes behavior", async () => {
    const redis = new RedisMock();
    await maybeSendBudgetAlert(deps({ redis }), { orgId: "o1", event: "exceeded", monthToDate: "11", budget: "10", behavior: "halt" });
    expect(await redis.get("alert-sent:exceeded:o1:2026-06:halt")).toBe("1");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗** — `pnpm --filter @caliber/gateway test -- budgetAlertWebhook` → FAIL。

- [ ] **Step 3: 實作**

`apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts`：

```ts
import type { Redis } from "ioredis";

// Active webhook alert for org budget warn/exceeded (spec §4.3). Fire-and-forget:
// never throws, never blocks the caller. send-then-mark dedup: only write the
// monthly dedup key AFTER a 2xx, so a failed POST is retried next time instead
// of permanently suppressing alerts for that org+month.

export interface BudgetAlertEvent {
  orgId: string;
  event: "warn" | "exceeded";
  monthToDate: string; // decimal string
  budget: string; // decimal string
  behavior?: "degrade" | "halt"; // only for exceeded
}

export interface BudgetAlertDeps {
  redis: Redis;
  fetch: typeof globalThis.fetch;
  webhookUrl?: string;
  logger: { warn: (obj: unknown, msg?: string) => void };
  now: () => Date;
}

const ALERT_TTL_SEC = 35 * 24 * 60 * 60; // ~longer than any month
const INFLIGHT_TTL_SEC = 30;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dedupKey(e: BudgetAlertEvent, month: string): string {
  return e.event === "exceeded"
    ? `alert-sent:exceeded:${e.orgId}:${month}:${e.behavior ?? "unknown"}`
    : `alert-sent:warn:${e.orgId}:${month}`;
}

export async function maybeSendBudgetAlert(
  deps: BudgetAlertDeps,
  e: BudgetAlertEvent,
): Promise<void> {
  if (!deps.webhookUrl) return;
  const month = monthKey(deps.now());
  const dk = dedupKey(e, month);
  try {
    if ((await deps.redis.exists(dk)) === 1) return; // already alerted this month
    // short in-flight lock to avoid concurrent double-send
    const lock = await deps.redis.set(`${dk}:lock`, "1", "EX", INFLIGHT_TTL_SEC, "NX");
    if (lock === null) return;

    const res = await deps.fetch(deps.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: e.event,
        orgId: e.orgId,
        monthToDate: e.monthToDate,
        budget: e.budget,
        ...(e.behavior ? { behavior: e.behavior } : {}),
        ts: deps.now().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      await deps.redis.set(dk, "1", "EX", ALERT_TTL_SEC); // mark only on success
    } else {
      deps.logger.warn({ status: res.status, orgId: e.orgId }, "budget_alert_webhook_non_2xx");
    }
    await deps.redis.del(`${dk}:lock`);
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: e.orgId },
      "budget_alert_webhook_failed",
    );
  }
}
```

- [ ] **Step 4: 跑測試** — `pnpm --filter @caliber/gateway test -- budgetAlertWebhook` → PASS（5/5）。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/budgetAlertWebhook.ts apps/gateway/tests/workers/budgetAlertWebhook.test.ts
git commit -m "feat(gateway): budgetAlertWebhook — fire-and-forget org budget alert (send-then-mark dedup)"
```

---

## Task 7: gateway — 把 webhook 接進 wrapEnforceBudget

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts`
- Modify: `apps/gateway/src/workers/evaluator/runFacetExtraction.ts`
- Test: `apps/gateway/tests/workers/enforceBudgetWithMetrics.test.ts`（擴充既有；若無則新建小測）

- [ ] **Step 1: wrapEnforceBudget 加可選 `onBudgetEvent` 回呼**

在 `enforceBudgetWithMetrics.ts` 的 `wrapEnforceBudget` 簽章加第三個可選參數：

```ts
export function wrapEnforceBudget(
  deps: EnforceBudgetDeps,
  metrics: Pick<GatewayMetrics, "gwLlmBudgetWarnTotal" | "gwLlmBudgetExceededTotal">,
  onBudgetEvent?: (e: {
    orgId: string;
    event: "warn" | "exceeded";
    monthToDate: string;
    budget: string;
    behavior?: "degrade" | "halt";
  }) => void,
): (orgId: string, estimatedCost: number) => Promise<void> {
```

- [ ] **Step 2: 在 warn / exceeded 發 metric 處同時呼叫回呼（fire-and-forget）**

warn 分支（`metrics.gwLlmBudgetWarnTotal.inc(...)` 之後）：

```ts
          metrics.gwLlmBudgetWarnTotal.inc({ org_id: orgId });
          onBudgetEvent?.({
            orgId,
            event: "warn",
            monthToDate: String(monthSpend),
            budget: String(org.llm_monthly_budget_usd),
          });
```

exceeded 的兩個分支（degrade / halt，各自 `metrics.gwLlmBudgetExceededTotal.inc(...)` 之後）：

```ts
        onBudgetEvent?.({ orgId, event: "exceeded", monthToDate: "", budget: "", behavior: "degrade" });
```
```ts
        onBudgetEvent?.({ orgId, event: "exceeded", monthToDate: "", budget: "", behavior: "halt" });
```

> exceeded 分支在 catch 內、`enforceBudget` 已 throw，當下沒有現成的 monthToDate/budget 數值；以空字串帶過（webhook payload 仍含 orgId/event/behavior/ts，足以告警）。**回呼必須是同步、不可拋**（呼叫端用 `void maybeSendBudgetAlert(...)` 包成 fire-and-forget，見 Step 3）。

- [ ] **Step 3: runFacetExtraction.ts 構造 alert sink 傳入**

在 `apps/gateway/src/workers/evaluator/runFacetExtraction.ts` 既有 `wrapEnforceBudget(budgetDeps, { gwLlmBudgetWarnTotal, gwLlmBudgetExceededTotal })`（約 line 147）改為傳第三參數。先在該函式可取得 `redis`/`env`/`logger` 的範圍（既有 worker context 應有；若無則從 worker 入口注入）construct：

```ts
import { maybeSendBudgetAlert } from "./budgetAlertWebhook.js";
// ...
wrapEnforceBudget(
  budgetDeps,
  { gwLlmBudgetWarnTotal, gwLlmBudgetExceededTotal },
  (e) => {
    void maybeSendBudgetAlert(
      { redis, fetch: globalThis.fetch, webhookUrl: env.GATEWAY_ALERT_WEBHOOK_URL, logger, now: () => new Date() },
      e,
    );
  },
)
```

> 若該檔當下無 `redis`/`env`/`logger` 在 scope：grep `runFacetExtraction` 的呼叫鏈，從 worker 入口（建立 BullMQ worker 處）把 `redis`/`env`/`logger` 往下傳。若接線過於侵入，**改為**在 wrapEnforceBudget 的呼叫端最近能取得這些依賴的層級構造 sink（保持 sink 為純 fire-and-forget 閉包）。實作者回報實際接線點。

- [ ] **Step 4: 測試 + typecheck**

擴充 `enforceBudgetWithMetrics` 測試：傳入一個 spy `onBudgetEvent`，斷言 warn 時被呼叫一次且 event="warn"；exceeded(halt) 時 event="exceeded"+behavior="halt"。
Run: `pnpm --filter @caliber/gateway test -- enforceBudget && pnpm --filter @caliber/gateway typecheck` → PASS / clean。

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts apps/gateway/src/workers/evaluator/runFacetExtraction.ts apps/gateway/tests/workers/
git commit -m "feat(gateway): wire budget webhook alert into wrapEnforceBudget warn/exceeded"
```

---

## Task 8: compose — cloudflared 服務 + tunnel network

**Files:**
- Modify: `docker/docker-compose.yml`

- [ ] **Step 1: 加 `tunnel` network（top-level）**

在 `docker-compose.yml` 末尾的 top-level（與 `volumes:` 同層）加：

```yaml
networks:
  tunnel:
    driver: bridge
    # NOT internal: cloudflared needs egress to reach Cloudflare. Isolation
    # comes from only gateway + cloudflared joining this network.
```

- [ ] **Step 2: gateway 服務接 `tunnel` + alias；加 cloudflared 服務**

在 `gateway:` 服務加 `networks`（同時保留預設 app network — compose 預設網段名通常是 `default`；若該 compose 未顯式定義其他 network，gateway 仍需接 `default` 以連 postgres/redis/api）：

```yaml
    networks:
      default: {}
      tunnel:
        aliases:
          - gateway-tunnel
```

在 `gateway:` 之後加 cloudflared 服務：

```yaml
  cloudflared:
    # Opt-in: `docker compose --profile gateway --profile tunnel up`.
    # Named Cloudflare tunnel — exposes the gateway publicly without a per-user
    # VPN. Origin is configured (in the CF dashboard) to http://gateway-tunnel:3002
    # so traffic always reaches the gateway over the dedicated `tunnel` network.
    profiles: [tunnel]
    image: cloudflare/cloudflared:2026.1.0
    restart: unless-stopped
    command: ["tunnel", "--no-autoupdate", "run", "--token", "${TUNNEL_TOKEN:-}"]
    depends_on:
      gateway:
        condition: service_started
    networks:
      - tunnel
```

> **實作時把 image tag `2026.1.0` 換成當下 `cloudflare/cloudflared` 最新穩定 tag**（`docker pull cloudflare/cloudflared:<tag>` 確認存在）；不可用 `latest`。

- [ ] **Step 3: 驗證 compose 設定合法**

Run（不需起容器）：`cd docker && docker compose --profile gateway --profile tunnel config >/dev/null && echo OK`
Expected: `OK`（YAML + interpolation 合法；`TUNNEL_TOKEN` 未設時用 `${TUNNEL_TOKEN:-}` 軟預設不報錯）。

- [ ] **Step 4: Commit**

```bash
git add docker/docker-compose.yml
git commit -m "feat(deploy): cloudflared named-tunnel service on a dedicated tunnel network"
```

---

## Task 9: docs runbook

**Files:**
- Modify: `docs/GATEWAY.md`（或 `docs/MULTI_DEVICE.md`）

- [ ] **Step 1: 加「Cloudflare named tunnel」runbook 段落**

於 `docs/GATEWAY.md`（連線/部署相關段落，或 `MULTI_DEVICE.md §2` tunnel 段）新增/擴充，內容涵蓋：
1. **建 named tunnel**：Cloudflare Zero Trust → Networks → Tunnels → 建 tunnel → 取 token；public hostname 的 **origin 設 `http://gateway-tunnel:3002`**。
2. **設 env**：`TUNNEL_TOKEN=<token>`、`GATEWAY_BASE_URL=https://<你的 hostname>`、`GATEWAY_TRUSTED_PROXIES=<tunnel network CIDR>`（**不可**用整個 default Docker CIDR）。如何查 tunnel network CIDR：`docker network inspect docker_tunnel --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`。
3. **啟動**：`docker compose --profile gateway --profile tunnel up -d`。
4. **key 衛生**（公開後）：發短 TTL key、定期撤銷、監控用量（gw_llm_* metrics / status 頁）。
5. **暴力節流 env**：`GATEWAY_AUTH_FAIL_MAX`(10)/`WINDOW_SEC`(300)/`BLOCK_SEC`(900) 說明 + `=0` 停用。
6. **webhook 告警**：`GATEWAY_ALERT_WEBHOOK_URL` 說明 + payload 範例（`{event,orgId,monthToDate,budget,behavior?,ts}`）+ 一個極簡接收端範例（如 Slack incoming webhook 需自行轉換格式）。

- [ ] **Step 2: 連結檢查** — `grep -n "gateway-tunnel:3002\|TUNNEL_TOKEN\|GATEWAY_ALERT_WEBHOOK_URL\|GATEWAY_AUTH_FAIL" docs/GATEWAY.md` 應全部出現。

- [ ] **Step 3: Commit**

```bash
git add docs/GATEWAY.md
git commit -m "docs: P4 Cloudflare named-tunnel runbook + throttle/webhook knobs"
```

---

## 完成後

- [ ] 全套件回歸：`pnpm --filter @caliber/config test && pnpm --filter @caliber/gateway test -- "resolveClientIp|ipAuthThrottle|apiKeyAuth|budgetAlertWebhook|enforceBudget|metrics"`
- [ ] 型別：`pnpm --filter @caliber/config typecheck && pnpm --filter @caliber/gateway typecheck`
- [ ] compose 驗證：`cd docker && docker compose --profile gateway --profile tunnel config >/dev/null`
- [ ] 進 `superpowers:finishing-a-development-branch`（已在 `feat/p4-connectivity-tunnel` 分支）。
- [ ] **部署收尾（operator 手動）**：CF 建 tunnel + 設 env → `--profile tunnel up -d cloudflared` → 公開 URL 打 `/v1/messages` 200（real IP 正確）。

## 不變式回顧（對應 spec §7）
- **INV-P1**：認證成功（key 有效 ∧ 通過 IP policy）永不節流；只認證失敗計數/封鎖。
- **INV-P2**：節流 + IP 白名單用 `resolveClientIp`（socket peer 受信才採信 CF-Connecting-IP）。
- **INV-P3**：webhook fire-and-forget、不阻斷、payload 無秘密。
- **INV-P4**：tunnel 純加法（profile 選用），不改既有存取。
- **INV-P5**：Redis 故障時節流 fail-open。
