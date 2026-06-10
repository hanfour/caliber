# Model Alias Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The gateway resolves model *aliases* (`-latest` suffix or bare family name) to the family-newest concrete id from a per-credential-bucket, live-fetched + cached `/v1/models` catalog (static fallback), rewriting the upstream request; explicit concrete ids pass through untouched.

**Architecture:** A pure `resolveModelAlias` (gateway-core, no I/O) + an apps/gateway `modelRegistry` (per-bucket cache, background refresh, vault-credentialed fetch, fallback). Resolution is entitlement-aware: it runs per upstream attempt against the catalog of the selected account's bucket `(platform, routeUpstreamBaseUrl, credential.type)`. A side-effect-free bucket-preview helper lets single-bucket requests resolve up-front so the non-streaming response cache key includes the resolved model.

**Tech Stack:** TypeScript, pnpm workspaces, Fastify, Vitest, drizzle-orm, prom-client.

**Spec:** `docs/superpowers/specs/2026-06-10-model-alias-resolution-design.md`

---

## File Structure

**New (gateway-core, pure):**
- `packages/gateway-core/src/models/types.ts` — `ModelCatalogEntry`, `Platform`, `BucketKey`, `ResolveResult`.
- `packages/gateway-core/src/models/resolveModelAlias.ts` — pure resolver.
- `packages/gateway-core/src/models/index.ts` — re-exports; wire into the package's `./models` subpath export.

**New (apps/gateway, I/O):**
- `apps/gateway/src/models/modelCatalogFetch.ts` — fetch + normalize `/v1/models` → `ModelCatalogEntry[]` per platform.
- `apps/gateway/src/models/staticFallback.ts` — built-in family→newest map + env override parse.
- `apps/gateway/src/models/modelRegistry.ts` — per-bucket cache + background refresh + fallback + metrics.
- `apps/gateway/src/models/bucketPreview.ts` — side-effect-free possible-bucket-set preview.

**Modified:**
- `packages/config/src/env.ts` — `GATEWAY_ENABLE_MODEL_ALIAS`, `GATEWAY_MODEL_REGISTRY_REFRESH_SEC`, `GATEWAY_MODEL_REGISTRY_FALLBACK_*`.
- `apps/gateway/src/runtime/metricsRegistry.ts` (or wherever `gwMetrics` is built) — three new counters.
- `apps/gateway/src/runtime/withSlotAndCredential.ts` — expose `credential.type` to the attempt callback (runtime bucket).
- `apps/gateway/src/routes/messages.ts`, `chatCompletions.ts`, `responses.ts`, `codexResponses.ts` — call resolution, rewrite body model, set header, thread requested-vs-resolved.
- `apps/gateway/src/runtime/responseCache.ts` — include resolved model in the non-streaming cache key; preserve header on hit.
- `apps/gateway/src/runtime/syntheticUsageShapes.ts` + `usageLogging.ts` — synthetic usage uses resolved id; keep requested=alias.

**Phasing (each phase = working, testable software):**
- Phase 0 — Spike (Task 1).
- Phase 1 — Pure core (Tasks 2–6): types + resolver. No behavior change yet.
- Phase 2 — Registry + fallback + preview (Tasks 7–11).
- Phase 3 — Config + metrics (Tasks 12–13).
- Phase 4 — Wiring (Tasks 14–19): credential.type plumbing, the 4 routes, cache, usage threading.
- Phase 5 — Integration + deploy verification (Tasks 20–21).

> NOTE on the spike: Tasks 7–8 write the fetch/normalize against the **documented** `/v1/models` shapes (Anthropic `{data:[{id,created_at:ISO}]}`; OpenAI `{data:[{id,created:unix_sec}]}`). The Task 1 spike VALIDATES these; if a real shape differs, adjust the normalize map in Task 8 before continuing.

---

## Phase 0 — Spike

### Task 1: Live-probe both `/v1/models` endpoints + capture raw shape

**Files:**
- Create: `docs/superpowers/spikes/2026-06-10-model-catalog-endpoints.md` (findings)

- [ ] **Step 1: Issue a throwaway own-policy api key (or reuse a pool key) for the gateway**, and obtain one active Anthropic upstream's credential class (api_key and/or Max OAuth) + the OpenAI codex upstream.

- [ ] **Step 2: Probe Anthropic `GET https://api.anthropic.com/v1/models`** with (a) an api_key (`x-api-key` + `anthropic-version: 2023-06-01`) and (b) a Claude Max OAuth token (`authorization: Bearer sk-ant-oat...`). Record for each: HTTP status, whether it works, and the JSON shape — exact field names for **id** and **created/timestamp** (expect `created_at` ISO string), pagination fields (`has_more`/`first_id`/`last_id`), required headers.

Run (from inside the api/gateway container to match egress):
```bash
docker exec docker-gateway-1 node -e 'fetch("https://api.anthropic.com/v1/models",{headers:{"x-api-key":process.env.K,"anthropic-version":"2023-06-01"}}).then(async r=>{console.log(r.status); const t=await r.text(); console.log(t.slice(0,600));})'
```

- [ ] **Step 3: Probe OpenAI via sub2api** `GET ${UPSTREAM_OPENAI_BASE_URL}/v1/models` with the codex credential. Record: does the endpoint exist? status, shape (`id`, `created` unix seconds), pagination.

- [ ] **Step 4: Write findings doc** capturing, per platform: endpoint usable Y/N, which credential type(s) work, the **normalize mapping** (raw field → `{id, created:number}`; ISO→epoch-ms or unix-sec→ms), pagination handling, and empty/malformed-body behavior. State per-platform whether the effective source is **live** or **static-fallback-only**.

- [ ] **Step 5: Commit**
```bash
git add docs/superpowers/spikes/2026-06-10-model-catalog-endpoints.md
git commit -m "spike: probe Anthropic + sub2api /v1/models shape for model alias resolution"
```

- [ ] **Step 6: Reconcile** — if either real shape differs from the assumptions noted above, edit Task 8's normalize code accordingly before implementing it.

---

## Phase 1 — Pure core (gateway-core)

### Task 2: Catalog + resolve types

**Files:**
- Create: `packages/gateway-core/src/models/types.ts`
- Test: (covered via resolver tests in later tasks)

- [ ] **Step 1: Write the types**
```typescript
// packages/gateway-core/src/models/types.ts
export type Platform = "anthropic" | "openai";

/** One normalized model from a provider /v1/models list. `created` is epoch ms. */
export interface ModelCatalogEntry {
  id: string;
  created: number;
}

/** Cache/bucket identity — entitlement-aware (see spec §Catalog bucketing). */
export interface BucketKey {
  platform: Platform;
  baseUrl: string;
  credentialType: "api_key" | "oauth";
}

export interface ResolveResult {
  /** The model id to send upstream (== requested when not an alias / unresolvable). */
  resolved: string;
  /** True only when an alias was matched and rewritten. */
  wasAlias: boolean;
  /** The family prefix matched (diagnostics / metrics label). */
  family?: string;
}

export function bucketKeyString(b: BucketKey): string {
  return `${b.platform}|${b.baseUrl}|${b.credentialType}`;
}
```

- [ ] **Step 2: Commit**
```bash
git add packages/gateway-core/src/models/types.ts
git commit -m "feat(models): catalog + resolve types"
```

### Task 3: `resolveModelAlias` — concrete pass-through + happy-path family resolution

**Files:**
- Create: `packages/gateway-core/src/models/resolveModelAlias.ts`
- Test: `packages/gateway-core/tests/models/resolveModelAlias.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// packages/gateway-core/tests/models/resolveModelAlias.test.ts
import { describe, it, expect } from "vitest";
import { resolveModelAlias } from "../../src/models/resolveModelAlias.js";
import type { ModelCatalogEntry } from "../../src/models/types.js";

const A: ModelCatalogEntry[] = [
  { id: "claude-haiku-4-5-20251001", created: 2000 },
  { id: "claude-haiku-3-5-20241022", created: 1000 },
  { id: "claude-sonnet-4-5-20250929", created: 1500 },
];

describe("resolveModelAlias (anthropic)", () => {
  it("passes an exact concrete id through untouched", () => {
    const r = resolveModelAlias("claude-haiku-3-5-20241022", "anthropic", A);
    expect(r).toEqual({ resolved: "claude-haiku-3-5-20241022", wasAlias: false });
  });
  it("resolves a bare family to the newest by created", () => {
    const r = resolveModelAlias("claude-haiku", "anthropic", A);
    expect(r.resolved).toBe("claude-haiku-4-5-20251001");
    expect(r.wasAlias).toBe(true);
    expect(r.family).toBe("claude-haiku");
  });
  it("resolves a -latest suffix to the newest", () => {
    const r = resolveModelAlias("claude-sonnet-latest", "anthropic", A);
    expect(r.resolved).toBe("claude-sonnet-4-5-20250929");
    expect(r.wasAlias).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd packages/gateway-core && pnpm vitest run tests/models/resolveModelAlias.test.ts`
Expected: FAIL — `resolveModelAlias` not found.

- [ ] **Step 3: Write minimal implementation**
```typescript
// packages/gateway-core/src/models/resolveModelAlias.ts
import type { ModelCatalogEntry, Platform, ResolveResult } from "./types.js";

const passthrough = (m: string): ResolveResult => ({ resolved: m, wasAlias: false });

export function resolveModelAlias(
  requested: string,
  platform: Platform,
  catalog: ModelCatalogEntry[],
): ResolveResult {
  // Exact concrete id → never touch.
  if (catalog.some((e) => e.id === requested)) return passthrough(requested);

  // Alias form → family prefix.
  const family = requested.endsWith("-latest")
    ? requested.slice(0, -"-latest".length)
    : requested;

  const members = familyMembers(requested, family, platform, catalog);
  if (members.length === 0) return passthrough(requested);

  const newest = pickNewest(members);
  return { resolved: newest.id, wasAlias: true, family };
}

function pickNewest(members: ModelCatalogEntry[]): ModelCatalogEntry {
  return members.reduce((best, e) =>
    e.created > best.created || (e.created === best.created && e.id > best.id) ? e : best,
  );
}

function familyMembers(
  requested: string,
  family: string,
  platform: Platform,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  if (platform === "anthropic") {
    const prefix = `${family}-`;
    return catalog.filter((e) => e.id.startsWith(prefix));
  }
  // openai handled in Task 5 (conservative). Default: no match for now.
  return openaiFamilyMembers(family, catalog);
}

// Placeholder until Task 5 — keep export stable.
function openaiFamilyMembers(_family: string, _catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cd packages/gateway-core && pnpm vitest run tests/models/resolveModelAlias.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add packages/gateway-core/src/models/resolveModelAlias.ts packages/gateway-core/tests/models/resolveModelAlias.test.ts
git commit -m "feat(models): resolveModelAlias — concrete passthrough + anthropic family-newest"
```

### Task 4: Resolver edge cases — tie-break, empty catalog, unknown family

**Files:**
- Modify: `packages/gateway-core/tests/models/resolveModelAlias.test.ts`

- [ ] **Step 1: Add failing tests**
```typescript
describe("resolveModelAlias edge cases", () => {
  it("ties break to lexicographically-greatest id", () => {
    const cat = [
      { id: "claude-opus-4-1-20250101", created: 9 },
      { id: "claude-opus-4-2-20250101", created: 9 },
    ];
    expect(resolveModelAlias("claude-opus", "anthropic", cat).resolved).toBe("claude-opus-4-2-20250101");
  });
  it("passes through when family has no members", () => {
    expect(resolveModelAlias("claude-nope", "anthropic", A)).toEqual({ resolved: "claude-nope", wasAlias: false });
  });
  it("passes through on empty catalog", () => {
    expect(resolveModelAlias("claude-haiku", "anthropic", [])).toEqual({ resolved: "claude-haiku", wasAlias: false });
  });
});
```

- [ ] **Step 2: Run** — `cd packages/gateway-core && pnpm vitest run tests/models/resolveModelAlias.test.ts`
Expected: PASS (the Task 3 impl already covers these — confirms behavior). If any fails, fix the impl minimally.

- [ ] **Step 3: Commit**
```bash
git add packages/gateway-core/tests/models/resolveModelAlias.test.ts
git commit -m "test(models): resolver tie-break / unknown-family / empty-catalog"
```

### Task 5: OpenAI conservative family matching

**Files:**
- Modify: `packages/gateway-core/src/models/resolveModelAlias.ts`
- Modify: `packages/gateway-core/tests/models/resolveModelAlias.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
const O: ModelCatalogEntry[] = [
  { id: "gpt-5-2025-08-01", created: 100 },
  { id: "gpt-5-2025-09-01", created: 200 },
  { id: "gpt-5-mini-2025-09-01", created: 250 },
];
describe("resolveModelAlias (openai, conservative)", () => {
  it("resolves gpt-5 to newest gpt-5 dated id, NOT gpt-5-mini", () => {
    const r = resolveModelAlias("gpt-5", "openai", O);
    expect(r.resolved).toBe("gpt-5-2025-09-01");
  });
  it("resolves gpt-5-mini family separately", () => {
    expect(resolveModelAlias("gpt-5-mini", "openai", O).resolved).toBe("gpt-5-mini-2025-09-01");
  });
  it("passes through when family is ambiguous/unmatched", () => {
    expect(resolveModelAlias("gpt", "openai", O)).toEqual({ resolved: "gpt", wasAlias: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd packages/gateway-core && pnpm vitest run tests/models/resolveModelAlias.test.ts`
Expected: FAIL — `gpt-5` returns passthrough (openaiFamilyMembers is a stub).

- [ ] **Step 3: Implement conservative OpenAI matching** (replace the stub)
```typescript
const OPENAI_SUBMODEL_WORDS = ["mini", "nano", "micro", "turbo", "preview"];

function openaiFamilyMembers(family: string, catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const prefix = `${family}-`;
  return catalog.filter((e) => {
    if (!e.id.startsWith(prefix)) return false;
    // The char-run immediately after the family prefix must begin a
    // version/date segment, not another sub-model keyword (mini/nano/…).
    const rest = e.id.slice(prefix.length);
    const nextWord = rest.split("-")[0] ?? "";
    return !OPENAI_SUBMODEL_WORDS.includes(nextWord);
  });
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd packages/gateway-core && pnpm vitest run tests/models/resolveModelAlias.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**
```bash
git add packages/gateway-core/src/models/resolveModelAlias.ts packages/gateway-core/tests/models/resolveModelAlias.test.ts
git commit -m "feat(models): conservative OpenAI family matching (sub-model keywords excluded)"
```

### Task 6: Export `./models` subpath + build

**Files:**
- Create: `packages/gateway-core/src/models/index.ts`
- Modify: `packages/gateway-core/package.json` (exports map)

- [ ] **Step 1: Write the barrel**
```typescript
// packages/gateway-core/src/models/index.ts
export * from "./types.js";
export { resolveModelAlias } from "./resolveModelAlias.js";
```

- [ ] **Step 2: Add the subpath export** to `packages/gateway-core/package.json` `"exports"` (mirror the existing `./oauth` subpath entry — same `import`/`types` shape pointing at `dist/models/index.js` / `.d.ts`).

- [ ] **Step 3: Build + typecheck**
Run: `cd packages/gateway-core && pnpm build && pnpm typecheck && pnpm vitest run tests/models/`
Expected: PASS, clean.

- [ ] **Step 4: Commit**
```bash
git add packages/gateway-core/src/models/index.ts packages/gateway-core/package.json
git commit -m "feat(models): export gateway-core/models subpath"
```

---

> Phase 1 yields a tested pure resolver with zero behavior change. Continue to Phase 2.

---

## Phase 2 — Registry, fallback, preview (apps/gateway)

### Task 7: Static fallback map (+ env override)

**Files:**
- Create: `apps/gateway/src/models/staticFallback.ts`
- Test: `apps/gateway/tests/models/staticFallback.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// apps/gateway/tests/models/staticFallback.test.ts
import { describe, it, expect } from "vitest";
import { staticFallbackCatalog } from "../../src/models/staticFallback.js";

describe("staticFallbackCatalog", () => {
  it("returns a non-empty anthropic catalog with current families", () => {
    const cat = staticFallbackCatalog("anthropic", {});
    const ids = cat.map((e) => e.id);
    expect(ids.some((i) => i.startsWith("claude-haiku-"))).toBe(true);
    expect(ids.some((i) => i.startsWith("claude-sonnet-"))).toBe(true);
    expect(ids.some((i) => i.startsWith("claude-opus-"))).toBe(true);
  });
  it("applies an env override entry", () => {
    const cat = staticFallbackCatalog("anthropic", {
      GATEWAY_MODEL_REGISTRY_FALLBACK_ANTHROPIC: "claude-haiku-9-9-29991231",
    });
    expect(cat.map((e) => e.id)).toContain("claude-haiku-9-9-29991231");
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/gateway && pnpm vitest run tests/models/staticFallback.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (use the model ids confirmed working live 2026-06-10: `claude-haiku-4-5-20251001`; fill sonnet/opus with the current dated ids the spike/Anthropic docs confirm — update if the spike shows newer). `created` is a large constant so live fetch (real timestamps) always wins when present.
```typescript
// apps/gateway/src/models/staticFallback.ts
import type { ModelCatalogEntry, Platform } from "@caliber/gateway-core/models";

// Conservative known-newest per family. Live fetch overrides these whenever
// available; this only guards cold-start / fetch-failure. Keep ids current.
const DEFAULTS: Record<Platform, string[]> = {
  anthropic: [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1-20250805",
  ],
  openai: [
    "gpt-5.4-mini",
    "gpt-5.4",
  ],
};

const SENTINEL_CREATED = 1; // any real created timestamp out-ranks fallback

export function staticFallbackCatalog(
  platform: Platform,
  env: Record<string, string | undefined>,
): ModelCatalogEntry[] {
  const key = `GATEWAY_MODEL_REGISTRY_FALLBACK_${platform.toUpperCase()}`;
  const override = (env[key] ?? "").split(/[,\s]+/).filter(Boolean);
  const ids = override.length > 0 ? override : DEFAULTS[platform];
  return ids.map((id) => ({ id, created: SENTINEL_CREATED }));
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/gateway && pnpm vitest run tests/models/staticFallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/staticFallback.ts apps/gateway/tests/models/staticFallback.test.ts
git commit -m "feat(gateway): static fallback model catalog + env override"
```

### Task 8: Fetch + normalize `/v1/models`

**Files:**
- Create: `apps/gateway/src/models/modelCatalogFetch.ts`
- Test: `apps/gateway/tests/models/modelCatalogFetch.test.ts`

> Apply the Task 1 spike's confirmed shapes. Below assumes Anthropic `{data:[{id,created_at:ISO}]}` and OpenAI `{data:[{id,created:unix_sec}]}`.

- [ ] **Step 1: Write the failing test** (inject a fake fetch)
```typescript
// apps/gateway/tests/models/modelCatalogFetch.test.ts
import { describe, it, expect } from "vitest";
import { fetchModelCatalog } from "../../src/models/modelCatalogFetch.js";

const fakeFetch = (status: number, body: unknown) =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })) as unknown as typeof fetch;

describe("fetchModelCatalog", () => {
  it("normalizes Anthropic data[] with created_at ISO → epoch ms", async () => {
    const f = fakeFetch(200, { data: [{ id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" }] });
    const cat = await fetchModelCatalog("anthropic", "https://api.anthropic.com", { authHeaders: {}, fetchImpl: f });
    expect(cat).toEqual([{ id: "claude-haiku-4-5-20251001", created: Date.parse("2025-10-01T00:00:00Z") }]);
  });
  it("normalizes OpenAI data[] with created unix sec → ms", async () => {
    const f = fakeFetch(200, { data: [{ id: "gpt-5.4", created: 1735689600 }] });
    const cat = await fetchModelCatalog("openai", "https://sub2api", { authHeaders: {}, fetchImpl: f });
    expect(cat).toEqual([{ id: "gpt-5.4", created: 1735689600 * 1000 }]);
  });
  it("returns [] on non-2xx (caller falls back)", async () => {
    const cat = await fetchModelCatalog("anthropic", "https://x", { authHeaders: {}, fetchImpl: fakeFetch(404, {}) });
    expect(cat).toEqual([]);
  });
  it("returns [] on missing/garbage data", async () => {
    const cat = await fetchModelCatalog("anthropic", "https://x", { authHeaders: {}, fetchImpl: fakeFetch(200, { nope: 1 }) });
    expect(cat).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelCatalogFetch.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**
```typescript
// apps/gateway/src/models/modelCatalogFetch.ts
import type { ModelCatalogEntry, Platform } from "@caliber/gateway-core/models";

interface FetchOpts {
  authHeaders: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchModelCatalog(
  platform: Platform,
  baseUrl: string,
  opts: FetchOpts,
): Promise<ModelCatalogEntry[]> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      method: "GET",
      headers: opts.authHeaders,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const raw of data) {
    const r = raw as { id?: unknown; created?: unknown; created_at?: unknown };
    if (typeof r.id !== "string") continue;
    let created: number | null = null;
    if (platform === "anthropic" && typeof r.created_at === "string") {
      const ms = Date.parse(r.created_at);
      created = Number.isNaN(ms) ? null : ms;
    } else if (typeof r.created === "number" && Number.isFinite(r.created)) {
      created = r.created < 1e12 ? r.created * 1000 : r.created;
    }
    out.push({ id: r.id, created: created ?? 0 });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelCatalogFetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/modelCatalogFetch.ts apps/gateway/tests/models/modelCatalogFetch.test.ts
git commit -m "feat(gateway): fetch + normalize /v1/models per platform"
```

### Task 9: ModelRegistry — per-bucket cache, get(), set(), fallback

**Files:**
- Create: `apps/gateway/src/models/modelRegistry.ts`
- Test: `apps/gateway/tests/models/modelRegistry.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// apps/gateway/tests/models/modelRegistry.test.ts
import { describe, it, expect } from "vitest";
import { ModelRegistry } from "../../src/models/modelRegistry.js";
import type { BucketKey } from "@caliber/gateway-core/models";

const bk = (credentialType: "api_key" | "oauth"): BucketKey => ({
  platform: "anthropic", baseUrl: "https://api.anthropic.com", credentialType,
});

describe("ModelRegistry", () => {
  it("returns static fallback when a bucket has not been refreshed", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    const cat = reg.get(bk("oauth"));
    expect(cat.some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
  });
  it("returns the cached live catalog after set()", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    reg.set(bk("oauth"), [{ id: "claude-haiku-4-5-20251001", created: 9 }]);
    expect(reg.get(bk("oauth"))).toEqual([{ id: "claude-haiku-4-5-20251001", created: 9 }]);
  });
  it("keeps buckets isolated by credential type", () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    reg.set(bk("api_key"), [{ id: "only-apikey", created: 9 }]);
    expect(reg.get(bk("oauth")).some((e) => e.id === "only-apikey")).toBe(false);
  });
  it("emits the fallback metric when serving fallback", () => {
    const seen: string[] = [];
    const reg = new ModelRegistry({ env: {}, fallbackMetric: (p, t) => seen.push(`${p}:${t}`) });
    reg.get(bk("oauth"));
    expect(seen).toContain("anthropic:oauth");
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelRegistry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (cache + fallback; refresh loop added in Task 10)
```typescript
// apps/gateway/src/models/modelRegistry.ts
import {
  bucketKeyString,
  type BucketKey,
  type ModelCatalogEntry,
} from "@caliber/gateway-core/models";
import { staticFallbackCatalog } from "./staticFallback.js";

interface Deps {
  env: Record<string, string | undefined>;
  fallbackMetric: (platform: string, credentialType: string) => void;
}

export class ModelRegistry {
  private cache = new Map<string, ModelCatalogEntry[]>();
  constructor(private deps: Deps) {}

  get(bucket: BucketKey): ModelCatalogEntry[] {
    const hit = this.cache.get(bucketKeyString(bucket));
    if (hit && hit.length > 0) return hit;
    this.deps.fallbackMetric(bucket.platform, bucket.credentialType);
    return staticFallbackCatalog(bucket.platform, this.deps.env);
  }

  set(bucket: BucketKey, catalog: ModelCatalogEntry[]): void {
    this.cache.set(bucketKeyString(bucket), catalog);
  }

  buckets(): string[] {
    return [...this.cache.keys()];
  }
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/modelRegistry.ts apps/gateway/tests/models/modelRegistry.test.ts
git commit -m "feat(gateway): ModelRegistry per-bucket cache + fallback"
```

### Task 10: Background refresh loop (bucket discovery + per-bucket fetch)

**Files:**
- Modify: `apps/gateway/src/models/modelRegistry.ts`
- Test: `apps/gateway/tests/models/modelRegistryRefresh.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake bucket-discovery + fake fetch)
```typescript
// apps/gateway/tests/models/modelRegistryRefresh.test.ts
import { describe, it, expect, vi } from "vitest";
import { ModelRegistry } from "../../src/models/modelRegistry.js";

describe("ModelRegistry.refreshOnce", () => {
  it("discovers in-use buckets and populates each from fetch", async () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    const discover = vi.fn(async () => [
      { platform: "anthropic" as const, baseUrl: "https://api.anthropic.com", credentialType: "oauth" as const },
    ]);
    const fetcher = vi.fn(async () => [{ id: "claude-haiku-4-5-20251001", created: 7 }]);
    await reg.refreshOnce({ discoverBuckets: discover, fetchForBucket: fetcher });
    expect(reg.get({ platform: "anthropic", baseUrl: "https://api.anthropic.com", credentialType: "oauth" }))
      .toEqual([{ id: "claude-haiku-4-5-20251001", created: 7 }]);
  });
  it("leaves a bucket on fallback when its fetch returns []", async () => {
    const reg = new ModelRegistry({ env: {}, fallbackMetric: () => {} });
    await reg.refreshOnce({
      discoverBuckets: async () => [{ platform: "anthropic", baseUrl: "u", credentialType: "oauth" }],
      fetchForBucket: async () => [],
    });
    expect(reg.get({ platform: "anthropic", baseUrl: "u", credentialType: "oauth" }).some((e) => e.id.startsWith("claude-haiku-"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelRegistryRefresh.test.ts`
Expected: FAIL — `refreshOnce` not defined.

- [ ] **Step 3: Implement** — add to `ModelRegistry`:
```typescript
import type { BucketKey } from "@caliber/gateway-core/models";

export interface RefreshDeps {
  discoverBuckets: () => Promise<BucketKey[]>;
  fetchForBucket: (b: BucketKey) => Promise<ModelCatalogEntry[]>;
}

// inside class ModelRegistry:
  async refreshOnce(deps: RefreshDeps): Promise<void> {
    const buckets = await deps.discoverBuckets();
    for (const b of buckets) {
      try {
        const cat = await deps.fetchForBucket(b);
        if (cat.length > 0) this.set(b, cat); // empty → leave on fallback
      } catch {
        // swallow — never let refresh break the gateway
      }
    }
  }
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/gateway && pnpm vitest run tests/models/modelRegistryRefresh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/modelRegistry.ts apps/gateway/tests/models/modelRegistryRefresh.test.ts
git commit -m "feat(gateway): ModelRegistry.refreshOnce — bucket discovery + per-bucket fetch"
```

### Task 11: Bucket-preview helper (side-effect-free)

**Files:**
- Create: `apps/gateway/src/models/bucketPreview.ts`
- Test: `apps/gateway/tests/models/bucketPreview.test.ts`

> Reuses the scheduler's candidate-LISTING predicate (read-only). Does NOT call `scheduler.select()`. Returns the set of possible `credentialType`s (row-level `upstream_accounts.type`) for the request scope, mapped to bucket keys.

- [ ] **Step 1: Write the failing test** (inject a fake candidate lister returning rows with `type`)
```typescript
// apps/gateway/tests/models/bucketPreview.test.ts
import { describe, it, expect } from "vitest";
import { previewBuckets } from "../../src/models/bucketPreview.js";

describe("previewBuckets", () => {
  it("returns a single bucket when all candidate rows share a type", async () => {
    const rows = [{ type: "oauth" }, { type: "oauth" }];
    const set = await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => rows.map((r) => r.type as "oauth") });
    expect(set).toHaveLength(1);
    expect(set[0]).toEqual({ platform: "anthropic", baseUrl: "u", credentialType: "oauth" });
  });
  it("returns multiple buckets when types differ", async () => {
    const set = await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => ["oauth", "api_key"] });
    expect(set.map((b) => b.credentialType).sort()).toEqual(["api_key", "oauth"]);
  });
  it("returns [] when there are no candidates", async () => {
    expect(await previewBuckets({ platform: "anthropic", baseUrl: "u", listCandidateTypes: async () => [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `cd apps/gateway && pnpm vitest run tests/models/bucketPreview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
```typescript
// apps/gateway/src/models/bucketPreview.ts
import type { BucketKey, Platform } from "@caliber/gateway-core/models";

export interface PreviewInput {
  platform: Platform;
  baseUrl: string;
  /** Read-only listing of the row-level credential types of candidate accounts. */
  listCandidateTypes: () => Promise<Array<"api_key" | "oauth">>;
}

export async function previewBuckets(input: PreviewInput): Promise<BucketKey[]> {
  const types = new Set(await input.listCandidateTypes());
  return [...types].map((credentialType) => ({
    platform: input.platform,
    baseUrl: input.baseUrl,
    credentialType,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**
Run: `cd apps/gateway && pnpm vitest run tests/models/bucketPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/bucketPreview.ts apps/gateway/tests/models/bucketPreview.test.ts
git commit -m "feat(gateway): side-effect-free bucket preview from row-level candidate types"
```

> NOTE for the executor: `listCandidateTypes` must be implemented in Task 14 by reusing the scheduler's existing candidate-filter query (the same WHERE the scheduler applies for routingPolicy/userId/platform/schedulable), selecting only `upstream_accounts.type`. Do NOT call `scheduler.select()`.

---

> Phase 2 yields a tested registry + preview, still not wired into requests. Continue to Phase 3.

---

## Phase 3 — Config + metrics

### Task 12: Env knobs

**Files:**
- Modify: `packages/config/src/env.ts`
- Test: `packages/config/tests/env.test.ts` (follow the existing per-knob test style)

- [ ] **Step 1: Write a failing test** asserting the parsed defaults
```typescript
it("model-alias knobs default on / 3600", () => {
  const env = parseServerEnv({ ...minimalGatewayEnv });
  expect(env.GATEWAY_ENABLE_MODEL_ALIAS).toBe(true);
  expect(env.GATEWAY_MODEL_REGISTRY_REFRESH_SEC).toBe(3600);
});
```
(Use the file's existing `minimalGatewayEnv`/helper; match how other GATEWAY_* knobs are tested.)

- [ ] **Step 2: Run to verify it fails**
Run: `cd packages/config && pnpm vitest run tests/env.test.ts`
Expected: FAIL — keys undefined.

- [ ] **Step 3: Add to the schema** (near the other `GATEWAY_*` entries in `env.ts`, mirroring their `emptyAsUndefined`/`booleanUnion`/`z.coerce.number` patterns)
```typescript
GATEWAY_ENABLE_MODEL_ALIAS: booleanUnion.default(true),
GATEWAY_MODEL_REGISTRY_REFRESH_SEC: emptyAsUndefined(
  z.coerce.number().int().min(60).default(3600),
),
GATEWAY_MODEL_REGISTRY_FALLBACK_ANTHROPIC: emptyAsUndefined(z.string().optional()),
GATEWAY_MODEL_REGISTRY_FALLBACK_OPENAI: emptyAsUndefined(z.string().optional()),
```

- [ ] **Step 4: Run to verify it passes + the rest of the suite**
Run: `cd packages/config && pnpm vitest run && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Wire the four passthroughs into `docker/docker-compose.yml`** `x-app-env` anchor (mirror the existing `ANTHROPIC_OAUTH_*` block — `${VAR:-}` soft defaults) and document them in `docker/.env.example`.

- [ ] **Step 6: Commit**
```bash
git add packages/config/src/env.ts packages/config/tests/env.test.ts docker/docker-compose.yml docker/.env.example
git commit -m "feat(config): GATEWAY_ENABLE_MODEL_ALIAS + model registry knobs + compose wiring"
```

### Task 13: Metrics counters

**Files:**
- Modify: wherever `app.gwMetrics` counters are registered (search: `gw_slot_acquire_total` to find the registry module).
- Test: extend that module's existing metrics test if present, else assert via `register.getSingleMetricAsString`.

- [ ] **Step 1: Find the metrics module**
Run: `grep -rln "gw_slot_acquire_total" apps/gateway/src`

- [ ] **Step 2: Add three counters** (mirroring the existing counter registration style):
  - `gw_model_alias_resolved_total` labels `{platform, family}`
  - `gw_model_registry_fetch_total` labels `{platform, bucket_type, result}` (`result` ∈ ok|empty|error)
  - `gw_model_registry_fallback_used_total` labels `{platform, bucket_type}`
  Expose them on the `gwMetrics` object as `modelAliasResolvedTotal`, `modelRegistryFetchTotal`, `modelRegistryFallbackUsedTotal`.

- [ ] **Step 3: Typecheck + the metrics test**
Run: `cd apps/gateway && pnpm typecheck && pnpm vitest run <metrics test file>`
Expected: clean / PASS.

- [ ] **Step 4: Commit**
```bash
git add apps/gateway/src/runtime/<metrics module>.* apps/gateway/tests/<metrics test>
git commit -m "feat(gateway): model alias / registry metrics counters"
```

---

> Phase 3 done. Phase 4 wires resolution into the request path.

---

## Phase 4 — Wiring (apps/gateway)

> Design goal: keep the 4 routes thin via ONE shared helper. The cache key
> naturally includes the resolved model because each route resolves into the
> sanitized body **before** building `upstreamBodyBuf` (which `checkRouteCache`
> hashes). Single-bucket → resolve up-front; mixed-bucket → skip cache + resolve
> per attempt.

### Task 14: `listCandidateTypes` (read-only scheduler reuse) + registry decoration + refresh loop

**Files:**
- Create: `apps/gateway/src/models/candidateTypes.ts`
- Modify: `apps/gateway/src/server.ts` (decorate `app.modelRegistry`, start refresh loop, register `discoverBuckets`/`fetchForBucket`)
- Test: `apps/gateway/tests/models/candidateTypes.test.ts`

- [ ] **Step 1: Identify the scheduler's candidate-filter query** — read `apps/gateway/src/runtime/scheduler.ts` for the WHERE clause it builds from `{orgId,teamId,groupPlatform,groupId,routingPolicy,userId,schedulable...}`. `candidateTypes.ts` will run the SAME filter but `SELECT DISTINCT upstream_accounts.type` (read-only; no sticky, no metrics, no select()).

- [ ] **Step 2: Write a failing integration test** (real test DB, seed an own oauth + a pool api_key upstream; assert `listCandidateTypes` returns the right set for a given scope). Mirror the seeding in `apps/gateway/tests/integration/*` if such a harness exists; otherwise unit-test the query builder with a fake db.

- [ ] **Step 3: Implement `candidateTypes.ts`** — a function `listCandidateTypes(db, scope) → Promise<("api_key"|"oauth")[]>` reusing the scheduler's candidate predicate, `SELECT DISTINCT type`.

- [ ] **Step 4: Decorate + start refresh** in `server.ts` (near the other `app.decorate` / cron starts): build `new ModelRegistry({ env: app.env, fallbackMetric: (p,t)=>app.gwMetrics.modelRegistryFallbackUsedTotal.inc({platform:p,bucket_type:t}) })`, `app.decorate("modelRegistry", reg)`, and start a `setInterval` (every `GATEWAY_MODEL_REGISTRY_REFRESH_SEC`) calling `reg.refreshOnce({ discoverBuckets, fetchForBucket })` where:
  - `discoverBuckets` = distinct `(platform, routeUpstreamBaseUrl, type)` over active upstreams (anthropic baseUrl = `UPSTREAM_ANTHROPIC_BASE_URL`|default; openai = `UPSTREAM_OPENAI_BASE_URL`).
  - `fetchForBucket(b)` = pick one active upstream of that `(platform,type)`, `resolveCredential` it, build the auth headers for that credential class, call `fetchModelCatalog(b.platform, b.baseUrl, {authHeaders})`, inc `modelRegistryFetchTotal{platform,bucket_type,result}`.
  Run one refresh immediately on boot (don't wait a full interval). Guard the whole block behind `GATEWAY_ENABLE_MODEL_ALIAS`.

- [ ] **Step 5: Typecheck + tests**
Run: `cd apps/gateway && pnpm typecheck && pnpm vitest run tests/models/`
Expected: clean / PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/gateway/src/models/candidateTypes.ts apps/gateway/src/server.ts apps/gateway/tests/models/candidateTypes.test.ts
git commit -m "feat(gateway): decorate modelRegistry + boot refresh loop + candidate-type listing"
```

### Task 15: Expose `credential.type` to the attempt callback (runtime bucket)

**Files:**
- Modify: `apps/gateway/src/runtime/withSlotAndCredential.ts:~69` (the `fn(credential)` call already receives `credential`, which carries `.type` — confirm the type union surfaces `"api_key" | "oauth"` to callers)
- Test: existing withSlotAndCredential tests stay green.

- [ ] **Step 1:** Confirm `fn(credential)` callers can read `credential.type`. If the `fn` signature/type erases it, widen the type so attempts can form the runtime bucket. (Likely already available — verify; no behavior change.)
- [ ] **Step 2:** `cd apps/gateway && pnpm typecheck && pnpm vitest run tests/runtime/withSlotAndCredential*` → clean/PASS.
- [ ] **Step 3: Commit** (only if a change was needed)
```bash
git add apps/gateway/src/runtime/withSlotAndCredential.ts
git commit -m "refactor(gateway): surface credential.type to upstream attempt callback"
```

### Task 16: Shared `applyModelResolution` helper

**Files:**
- Create: `apps/gateway/src/models/applyModelResolution.ts`
- Test: `apps/gateway/tests/models/applyModelResolution.test.ts`

> Encapsulates the route-side flow so the 4 routes stay thin.

- [ ] **Step 1: Write the failing test** (fake registry + fake previewBuckets)
```typescript
// apps/gateway/tests/models/applyModelResolution.test.ts
import { describe, it, expect } from "vitest";
import { applyModelResolution } from "../../src/models/applyModelResolution.js";

const reg = {
  get: (b: any) => b.credentialType === "oauth"
    ? [{ id: "claude-haiku-4-5-20251001", created: 9 }]
    : [{ id: "claude-haiku-4-5-20251001", created: 9 }],
} as any;

describe("applyModelResolution", () => {
  it("single bucket: resolves up-front, returns upstreamModel + cacheable=true", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: true,
      registry: reg, listCandidateTypes: async () => ["oauth"],
    });
    expect(r.upfront?.upstreamModel).toBe("claude-haiku-4-5-20251001");
    expect(r.cacheable).toBe(true);
    expect(r.requestedModel).toBe("claude-haiku");
  });
  it("mixed bucket: no up-front rewrite, cacheable=false, perAttempt resolver provided", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: true,
      registry: reg, listCandidateTypes: async () => ["oauth", "api_key"],
    });
    expect(r.upfront).toBeNull();
    expect(r.cacheable).toBe(false);
    expect(r.perAttempt("oauth").upstreamModel).toBe("claude-haiku-4-5-20251001");
  });
  it("disabled: passthrough, cacheable true, requested unchanged", async () => {
    const r = await applyModelResolution({
      requested: "claude-haiku", platform: "anthropic", baseUrl: "u", enabled: false,
      registry: reg, listCandidateTypes: async () => ["oauth"],
    });
    expect(r.upfront).toBeNull();
    expect(r.cacheable).toBe(true);
    expect(r.perAttempt("oauth").upstreamModel).toBe("claude-haiku");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/gateway && pnpm vitest run tests/models/applyModelResolution.test.ts` → FAIL.

- [ ] **Step 3: Implement**
```typescript
// apps/gateway/src/models/applyModelResolution.ts
import { resolveModelAlias, type Platform } from "@caliber/gateway-core/models";
import type { ModelRegistry } from "./modelRegistry.js";

interface Input {
  requested: string;
  platform: Platform;
  baseUrl: string;
  enabled: boolean;
  registry: ModelRegistry;
  listCandidateTypes: () => Promise<Array<"api_key" | "oauth">>;
}
interface Resolved { upstreamModel: string; wasAlias: boolean; family?: string; }
interface Output {
  requestedModel: string;            // always the original alias
  cacheable: boolean;                // false only for mixed-bucket
  upfront: Resolved | null;          // present iff single-bucket: rewrite body now
  perAttempt: (credentialType: "api_key" | "oauth") => Resolved; // runtime path
}

export async function applyModelResolution(input: Input): Promise<Output> {
  const requestedModel = input.requested;
  const perAttempt = (credentialType: "api_key" | "oauth"): Resolved => {
    if (!input.enabled) return { upstreamModel: requestedModel, wasAlias: false };
    const cat = input.registry.get({ platform: input.platform, baseUrl: input.baseUrl, credentialType });
    const r = resolveModelAlias(requestedModel, input.platform, cat);
    return { upstreamModel: r.resolved, wasAlias: r.wasAlias, family: r.family };
  };
  if (!input.enabled) {
    return { requestedModel, cacheable: true, upfront: null, perAttempt };
  }
  const types = [...new Set(await input.listCandidateTypes())];
  if (types.length === 1) {
    const upfront = perAttempt(types[0]!);
    return { requestedModel, cacheable: true, upfront, perAttempt };
  }
  // mixed-bucket (or zero candidates) → can't know served bucket up front
  return { requestedModel, cacheable: types.length === 0, upfront: null, perAttempt };
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/models/applyModelResolution.ts apps/gateway/tests/models/applyModelResolution.test.ts
git commit -m "feat(gateway): applyModelResolution helper (single-bucket up-front vs per-attempt)"
```

### Task 17: Wire `/v1/messages`

**Files:**
- Modify: `apps/gateway/src/routes/messages.ts`
- Test: `apps/gateway/tests/integration/messages.alias.test.ts`

- [ ] **Step 1: Write a failing integration test** — fake upstream that echoes the received `model`; seed a single own oauth upstream; POST `{model:"claude-haiku", ...}`; assert: upstream received `claude-haiku-4-5-20251001`, response header `x-caliber-resolved-model` set, and the usage_logs row has `requested_model="claude-haiku"`, `upstream_model="claude-haiku-4-5-20251001"`. (Reuse the existing messages integration harness + fake-upstream pattern.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — after the `missing_model` check, before building `sanitizedBody`:
  - `const resolution = await applyModelResolution({ requested: body.model, platform: "anthropic", baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE, enabled: opts.env.GATEWAY_ENABLE_MODEL_ALIAS, registry: app.modelRegistry, listCandidateTypes: () => listCandidateTypes(app.db, scope) });`
  - `const requestedModel = resolution.requestedModel;` (used for usage logging)
  - If `resolution.upfront`: set `sanitizedBody.model = resolution.upfront.upstreamModel`; if `wasAlias`, `reply.header("x-caliber-resolved-model", upstreamModel)` and `app.gwMetrics.modelAliasResolvedTotal.inc({platform:"anthropic", family: resolution.upfront.family ?? ""})`.
  - Build `upstreamBodyBuf` from the (possibly rewritten) `sanitizedBody` — cache key now includes the resolved model.
  - If `!resolution.cacheable`: SKIP the `checkRouteCache` block entirely (mixed bucket).
  - Inside the failover attempt (where `credential` is available): if `resolution.upfront` is null (mixed bucket), `const ra = resolution.perAttempt(credential.type)`, rewrite the per-attempt upstream body's model to `ra.upstreamModel`, set the header + metric when `ra.wasAlias`. (Where row-type≠credential-type, this is the authoritative rewrite — see spec.)
  - Keep `requestedModel` (alias) as the usage-log `requestedModel`; pass `ra.upstreamModel`/`resolution.upfront.upstreamModel` as the upstream model.

- [ ] **Step 4: Run to verify it passes + the existing messages tests stay green.**
Run: `cd apps/gateway && pnpm vitest run tests/integration/messages*`

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/routes/messages.ts apps/gateway/tests/integration/messages.alias.test.ts
git commit -m "feat(gateway): resolve model aliases on /v1/messages (cache-safe, per-attempt fallback)"
```

### Task 18: Wire OpenAI surfaces (`chatCompletions`, `responses`, `codexResponses`) + passthrough usage

**Files:**
- Modify: `apps/gateway/src/routes/chatCompletions.ts`, `responses.ts`, `codexResponses.ts`
- Modify: `apps/gateway/src/runtime/syntheticUsageShapes.ts`, `usageLogging.ts`
- Test: `apps/gateway/tests/integration/openaiAlias.test.ts`

- [ ] **Step 1: Write a failing integration test** — for the Responses passthrough path: POST `{model:"gpt-5"}`, fake upstream echoes the model; assert upstream received the resolved id, `x-caliber-resolved-model` set, and the synthetic usage log's `upstream_model` == resolved id while `requested_model` == `"gpt-5"`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — apply the same `applyModelResolution` flow as Task 17 in each OpenAI route (platform `"openai"`, baseUrl `UPSTREAM_OPENAI_BASE_URL`). Then fix the usage threading:
  - In `responses.ts` passthrough, the synthetic usage builder (`syntheticUsageShapes`) currently uses `requestedModel` as the upstream model (`responses.ts:~894`). Change the helper signature to take BOTH `requestedModel` (alias) and `upstreamModel` (resolved), and set the synthetic usage `model` to `upstreamModel`.
  - Audit `usageLogging.ts:~350` and all surfaces (messages, chatCompletions ×2, responses translator + passthrough) so `requested_model` is the alias and `upstream_model` is the resolved/extracted id consistently.

- [ ] **Step 4: Run to verify it passes + existing OpenAI route tests green.**

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/routes/chatCompletions.ts apps/gateway/src/routes/responses.ts apps/gateway/src/routes/codexResponses.ts apps/gateway/src/runtime/syntheticUsageShapes.ts apps/gateway/src/runtime/usageLogging.ts apps/gateway/tests/integration/openaiAlias.test.ts
git commit -m "feat(gateway): resolve model aliases on OpenAI surfaces + thread requested-vs-resolved usage"
```

### Task 19: Cache-hit header + row-type≠credential-type behavior

**Files:**
- Modify: `apps/gateway/src/runtime/responseCache.ts` (preserve `x-caliber-resolved-model` on a hit) and/or the route (set the header before `checkRouteCache` so a hit retains it)
- Test: `apps/gateway/tests/integration/messages.aliasCache.test.ts`

- [ ] **Step 1: Write failing tests**
  - (a) Cache enabled, single-bucket alias request → first call MISS resolves+caches under the resolved-model key; second identical call → HIT, and the response still carries `x-caliber-resolved-model`.
  - (b) Seed a row whose `type` (e.g. `oauth`) differs from the decrypted credential type; cache enabled; assert documented behavior: the up-front (row-type) resolution feeds the cache key, and the live attempt re-resolves/skips against the credential-derived bucket and emits a warning/metric (assert the warn/metric).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** — set `x-caliber-resolved-model` BEFORE `checkRouteCache` so a hit (which `reply.send`s) keeps the header; OR have `checkRouteCache`/`pickCacheableHeaders` persist+replay it. Add the drift warning+metric in the per-attempt path (Task 17/18) when `row.type !== credential.type`.

- [ ] **Step 4: Run to verify they pass + full gateway suite.**
Run: `cd apps/gateway && pnpm vitest run`

- [ ] **Step 5: Commit**
```bash
git add apps/gateway/src/runtime/responseCache.ts apps/gateway/src/routes/messages.ts apps/gateway/tests/integration/messages.aliasCache.test.ts
git commit -m "feat(gateway): preserve resolved-model header on cache hit + row/credential drift handling"
```

---

## Phase 5 — Integration + deploy verification

### Task 20: Full suites + typechecks green

- [ ] **Step 1:** Run all affected suites:
```bash
cd packages/gateway-core && pnpm vitest run && pnpm typecheck
cd ../config && pnpm vitest run && pnpm typecheck
cd ../../apps/gateway && pnpm vitest run && pnpm typecheck
```
Expected: all PASS, typechecks clean. Fix any regressions before continuing.

- [ ] **Step 2: Commit** any fixups
```bash
git commit -am "test: green model-alias suites across gateway-core/config/gateway"
```

### Task 21: Release + deploy + live smoke

- [ ] **Step 1:** Push main; tag `v0.13.0` (gateway+web+api, NO migration — zero schema); watch Release CI green.
- [ ] **Step 2:** Deploy h4: bump `docker/.env` `VERSION=v0.13.0`, `docker compose ... pull && up -d`, verify 5/5 healthy + migrate exit 0.
- [ ] **Step 3: Live smoke** through the gateway with an own-policy key (issue → reveal → revoke after):
  - `claude-haiku` → 200, response served as `claude-haiku-4-5-20251001`, `x-caliber-resolved-model` header present, usage_logs requested=`claude-haiku` / upstream=resolved id.
  - an explicit current id (e.g. `claude-haiku-4-5-20251001`) → 200, no header (passthrough).
  - confirm the registry refresh fetched live (or fell back) per the Task 1 spike outcome — check `gw_model_registry_fetch_total` / `_fallback_used_total` on the internal metrics port.
- [ ] **Step 4:** Update memory `project_state` with the shipped feature + spike outcome (live vs fallback per platform).

---

## Self-Review (completed)

- **Spec coverage:** alias-only behavior (T3–T5), both forms (T3,T5), both platforms (T5,T17,T18), per-bucket catalog + bucketing invariants (T9,T11,T14,T16,T17), live-fetch+cache+fallback (T7,T8,T9,T10), newest-by-created (T3), unresolvable passthrough (T4,T5), transparency header + requested/upstream logging (T17,T18,T19), cache ordering + skip-on-mixed + hit header (T16,T17,T19), OpenAI passthrough usage (T18), spike + raw shape (T1), GATEWAY_ env + metrics (T12,T13), side-effect-free preview (T11,T14). All covered.
- **Placeholders:** none (the only deferred specifics — exact `/v1/models` shape, scheduler candidate WHERE, metrics-module path — are explicit spike/grep steps, not silent TODOs).
- **Type consistency:** `ModelCatalogEntry{id,created}`, `BucketKey{platform,baseUrl,credentialType}`, `ResolveResult{resolved,wasAlias,family?}`, `applyModelResolution` Output shape — used consistently across tasks.
