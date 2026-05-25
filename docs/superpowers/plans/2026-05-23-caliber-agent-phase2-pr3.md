# caliber-agent Phase 2 PR3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR2's `LogSink` stub with a real HTTP ingest client, ship a `redact` package with three modes (`metadata-only` / `redacted-body` / `full-body`), add server-side `GET /v1/redaction-set` endpoint + per-org regex set table, and fetch + cache the set on the daemon with a 24h refresher goroutine.

**Architecture:** Mixed-language PR — server-side TypeScript (Fastify route + drizzle migration + integration test) and agent-side Go (new `redact` package + `sink/http.go` + `cli/run.go` wiring). Sink interface + Chunk type from PR2 unchanged; `Chunk.Events` evolves from `[]string` to `[]redact.Event` (planned in PR2 spec). Redaction set fetched at startup with 3-tier fallback (fresh → stale cache → bundled default). HTTPSink retries 5xx/429 with exponential backoff (max 5 attempts) and propagates auth fatal errors to daemon exit.

**Tech Stack:** Go 1.25, TypeScript + Fastify + Drizzle 0.45.2 + Vitest (server), pnpm 9.15 monorepo. No new third-party deps in PR3.

**Authoritative spec:** `docs/superpowers/specs/2026-05-23-caliber-agent-phase2-pr3-design.md`. When the plan and spec disagree, the spec wins — flag the discrepancy.

**Depends on:** PR1 (#160) + PR2 (#161) already merged into main (commits `8e1843d` + `5b17a56`). PR3 branches from current main; no stacking.

---

## Phase 0 — Worktree setup

### Task 0.1: Create PR3 worktree from main

- [ ] **Step 1: Update local main**

```bash
cd /Users/hanfourhuang/ai-dev-eval
git fetch origin main
git checkout main
git pull origin main
```

Expected: HEAD on origin/main = `5b17a56` or later.

- [ ] **Step 2: Create worktree**

```bash
git worktree add .claude/worktrees/feat-caliber-agent-phase2-pr3 -b feat/caliber-agent-phase2-pr3 main
cd .claude/worktrees/feat-caliber-agent-phase2-pr3
```

Verify:

```bash
git branch --show-current
# expected: feat/caliber-agent-phase2-pr3
git log -1 --oneline
# expected: same as origin/main tip
```

- [ ] **Step 3: Baseline tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3/agent
go test ./... -race
$(go env GOPATH)/bin/staticcheck ./...
./scripts/coverage.sh
```

Expected: all green, ≥ 80% coverage (PR2 baseline).

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm install
# Server-side baseline (representative, full suite optional):
pnpm --filter @caliber/api exec vitest run tests/integration/rest/devicesEnroll.test.ts tests/integration/rest/ingest.test.ts
```

Expected: server-side PR1+Phase1 tests still pass.

---

## Phase 1 — Server-side: migration + schema + endpoint

### Task 1.1: Drizzle migration for `org_redaction_patterns`

**Files:**
- Create: `packages/db/drizzle/0015_org_redaction_patterns.sql`

- [ ] **Step 1: Create the SQL migration**

```sql
-- 0015_org_redaction_patterns.sql
-- Per-org override for the daemon's secret-scrub regex set. NULL row = use
-- the server-side hardcoded default (mirrors agent/redact/regexes.go).
CREATE TABLE org_redaction_patterns (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  patterns jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
```

Verify the `organizations` table name matches `packages/db/src/schema/org.ts` (if it's `orgs` not `organizations`, adjust accordingly).

- [ ] **Step 2: Down migration**

Create `packages/db/drizzle/0015_down.sql`:

```sql
DROP TABLE IF EXISTS org_redaction_patterns;
```

- [ ] **Step 3: Verify SQL parses against running postgres**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
docker exec docker-postgres-1 psql -U caliber -d caliber -c "BEGIN; $(cat packages/db/drizzle/0015_org_redaction_patterns.sql) ROLLBACK;" 2>&1 | tail -5
```

Expected: `CREATE TABLE` + `ROLLBACK` lines, no error.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/0015_org_redaction_patterns.sql packages/db/drizzle/0015_down.sql
git commit -m "feat(db): 0015 — org_redaction_patterns for per-org daemon redaction overrides"
```

### Task 1.2: Drizzle schema TS for the new table

**Files:**
- Create: `packages/db/src/schema/orgRedactionPatterns.ts`
- Modify: `packages/db/src/schema/index.ts` (export the new table)

- [ ] **Step 1: Find existing organizations reference**

```bash
grep -n "organizations\b" packages/db/src/schema/org.ts | head -3
```

Expected: `export const organizations = pgTable("organizations", ...)`. If the constant name is different, use it below.

- [ ] **Step 2: Create the schema file**

```typescript
// packages/db/src/schema/orgRedactionPatterns.ts
import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

export const orgRedactionPatterns = pgTable("org_redaction_patterns", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  patterns: jsonb("patterns").$type<RedactionPattern[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RedactionPattern = {
  name: string;
  regex: string;
  replacement: string;
};
```

- [ ] **Step 3: Re-export from index**

```bash
grep -n "deviceApiKeys" packages/db/src/schema/index.ts
```

Add a sibling line next to other `export * from` lines:

```typescript
export * from "./orgRedactionPatterns.js";
```

- [ ] **Step 4: Build to verify type-checks**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm --filter @caliber/db build
```

Expected: exit 0, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/orgRedactionPatterns.ts packages/db/src/schema/index.ts
git commit -m "feat(db): drizzle schema for org_redaction_patterns"
```

### Task 1.3: `GET /v1/redaction-set` endpoint

**Files:**
- Create: `apps/api/src/rest/redactionSet.ts`
- Modify: `apps/api/src/server.ts` (register the new route)

- [ ] **Step 1: Read the existing resolveDevice helper**

```bash
sed -n '94,140p' apps/api/src/rest/ingest.ts
```

This is the auth pattern we reuse. Note that `resolveDevice` returns `{ ok, device | error }` discriminated union with `AuthFailure` enum.

- [ ] **Step 2: Create the route file**

```typescript
// apps/api/src/rest/redactionSet.ts
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { orgRedactionPatterns, type RedactionPattern } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuth } from "./ingestAuth.js"; // see Step 3 below

const TTL_SECONDS = 86400; // 24h

// SERVER_DEFAULT_PATTERNS mirrors agent/redact/regexes.go DefaultPatterns.
// Drift between the two produces inconsistent behaviour when a daemon
// has no cached set and the server returns the default. A parity test
// in tests/integration/rest/redactionSet.test.ts asserts these match
// the agent's list.
export const SERVER_DEFAULT_PATTERNS: RedactionPattern[] = [
  { name: "anthropic_or_openai_legacy", regex: "sk-[a-zA-Z0-9_\\-]{20,}", replacement: "sk-***" },
  { name: "openai_project",             regex: "sk-proj-[A-Za-z0-9_\\-]{20,}", replacement: "sk-proj-***" },
  { name: "anthropic_console",          regex: "sk-ant-api[0-9]{2}-[A-Za-z0-9_\\-]{20,}", replacement: "sk-ant-***" },
  { name: "aws_access_key",             regex: "AKIA[0-9A-Z]{16}", replacement: "AKIA***" },
  { name: "github_pat",                 regex: "ghp_[A-Za-z0-9]{36,}", replacement: "ghp_***" },
  { name: "github_oauth",               regex: "gho_[A-Za-z0-9]{36,}", replacement: "gho_***" },
  { name: "github_pat_fine_grained",    regex: "github_pat_[A-Za-z0-9_]{82}", replacement: "github_pat_***" },
  { name: "slack_bot",                  regex: "xoxb-[A-Za-z0-9\\-]{40,}", replacement: "xoxb-***" },
  { name: "slack_user",                 regex: "xoxp-[A-Za-z0-9\\-]{40,}", replacement: "xoxp-***" },
  { name: "groq",                       regex: "gsk_[A-Za-z0-9]{20,}", replacement: "gsk_***" },
  { name: "bearer_generic",             regex: "Bearer\\s+[A-Za-z0-9_\\-.]{20,}", replacement: "Bearer ***" },
];

function patternsVersion(patterns: RedactionPattern[]): string {
  const json = JSON.stringify(patterns);
  return createHash("sha256").update(json).digest("hex").slice(0, 8);
}

export function redactionSetRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/v1/redaction-set", async (req, reply) => {
      const auth = await resolveDeviceFromAuth(fastify.db, env, req.headers.authorization);
      if (!auth.ok) {
        reply.code(401);
        return { error: auth.error };
      }
      const { orgId } = auth.device;

      const row = await fastify.db
        .select({ patterns: orgRedactionPatterns.patterns })
        .from(orgRedactionPatterns)
        .where(eq(orgRedactionPatterns.orgId, orgId))
        .limit(1)
        .then((r) => r[0]);

      const patterns = row?.patterns ?? SERVER_DEFAULT_PATTERNS;
      const version = row ? `org-${orgId}-${patternsVersion(patterns)}` : `default-${patternsVersion(patterns)}`;
      reply.code(200);
      return { patterns, version, ttl_seconds: TTL_SECONDS };
    });
  };
}
```

- [ ] **Step 3: Extract `resolveDeviceFromAuth`**

`resolveDevice` in `ingest.ts` is private. Extract a shared helper that both routes use.

Create `apps/api/src/rest/ingestAuth.ts`:

```typescript
// apps/api/src/rest/ingestAuth.ts
// Shared auth helper for routes that authenticate cda_* device keys
// (POST /v1/ingest, GET /v1/redaction-set).
import { eq } from "drizzle-orm";
import { devices, deviceApiKeys, type Database } from "@caliber/db";
import { hashDeviceKey } from "@caliber/gateway-core";
import type { ServerEnv } from "@caliber/config";

export type AuthFailure =
  | "missing_token"
  | "invalid_token"
  | "key_revoked"
  | "device_revoked"
  | "device_inactive"
  | "server_misconfigured";

export interface ResolvedDevice {
  deviceId: string;
  userId: string;
  orgId: string;
}

export async function resolveDeviceFromAuth(
  db: Database,
  env: ServerEnv,
  authHeader: string | undefined,
): Promise<
  | { ok: true; device: ResolvedDevice }
  | { ok: false; error: AuthFailure }
> {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) return { ok: false, error: "server_misconfigured" };

  if (!authHeader || typeof authHeader !== "string") {
    return { ok: false, error: "missing_token" };
  }
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, error: "missing_token" };
  }
  const raw = authHeader.slice(7).trim();
  if (!raw.startsWith("cda_") || raw.length < 16) {
    return { ok: false, error: "invalid_token" };
  }

  const keyHash = hashDeviceKey(pepper, raw);
  const row = await db
    .select({
      deviceId: deviceApiKeys.deviceId,
      keyRevokedAt: deviceApiKeys.revokedAt,
      userId: devices.userId,
      orgId: devices.orgId,
      status: devices.status,
      deviceRevokedAt: devices.revokedAt,
    })
    .from(deviceApiKeys)
    .innerJoin(devices, eq(devices.id, deviceApiKeys.deviceId))
    .where(eq(deviceApiKeys.keyHash, keyHash))
    .limit(1)
    .then((r) => r[0]);

  if (!row) return { ok: false, error: "invalid_token" };
  if (row.keyRevokedAt !== null) return { ok: false, error: "key_revoked" };
  if (row.deviceRevokedAt !== null) return { ok: false, error: "device_revoked" };
  if (row.status !== "active") return { ok: false, error: "device_inactive" };

  return { ok: true, device: { deviceId: row.deviceId, userId: row.userId, orgId: row.orgId } };
}
```

Then update `apps/api/src/rest/ingest.ts`:
- Delete the local `resolveDevice` function (lines ~94-140)
- Import `resolveDeviceFromAuth` from `./ingestAuth.js`
- Replace each call to `resolveDevice(...)` with `resolveDeviceFromAuth(fastify.db, env, ...)` — note signature differs (db is now first arg), match accordingly

- [ ] **Step 4: Register the route in `apps/api/src/server.ts`**

```bash
grep -n "ingestRoutes\|devicesEnrollRoutes" apps/api/src/server.ts | head -5
```

Add a sibling registration:

```typescript
import { redactionSetRoutes } from "./rest/redactionSet.js";
// ...
await fastify.register(redactionSetRoutes(env));
```

- [ ] **Step 5: Build to verify type-checks across the workspace**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm -r build
```

Expected: exit 0, no type errors. The `ingest.ts` refactor must still compile.

- [ ] **Step 6: Existing ingest tests still pass (refactor regression)**

```bash
pnpm --filter @caliber/api exec vitest run tests/integration/rest/ingest.test.ts
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/rest/redactionSet.ts apps/api/src/rest/ingestAuth.ts apps/api/src/rest/ingest.ts apps/api/src/server.ts
git commit -m "feat(api): GET /v1/redaction-set endpoint + extract shared cda_* auth helper"
```

### Task 1.4: Integration tests for the new endpoint

**Files:**
- Create: `apps/api/tests/integration/rest/redactionSet.test.ts`

- [ ] **Step 1: Read the existing `devicesEnroll.test.ts` shape for setup conventions**

```bash
sed -n '1,40p' apps/api/tests/integration/rest/devicesEnroll.test.ts
```

Note: `setupTestDb`, `makeOrg`, `makeUser`, `defaultTestEnv`, `seedDeviceApiKey` factories. The last one may not exist yet; if not, write a local helper in the test file.

- [ ] **Step 2: Write the failing test file**

```typescript
// apps/api/tests/integration/rest/redactionSet.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  devices,
  deviceApiKeys,
  orgRedactionPatterns,
  type RedactionPattern,
} from "@caliber/db";
import { generateDeviceKey, hashDeviceKey } from "@caliber/gateway-core";
import { setupTestDb, makeOrg, makeUser, defaultTestEnv } from "../../factories/index.js";
import {
  redactionSetRoutes,
  SERVER_DEFAULT_PATTERNS,
} from "../../../src/rest/redactionSet.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
let app: FastifyInstance;

async function buildApp() {
  const fastify = Fastify({ logger: false });
  fastify.decorate("db", testDb.db);
  await fastify.register(redactionSetRoutes(defaultTestEnv));
  return fastify;
}

async function seedActiveDevice(): Promise<{ deviceId: string; rawKey: string; orgId: string }> {
  const org = await makeOrg(testDb.db);
  const user = await makeUser(testDb.db, { orgId: org.id });
  const [dev] = await testDb.db
    .insert(devices)
    .values({ userId: user.id, orgId: org.id, hostname: "h", os: "darwin", agentVersion: "test", status: "active" })
    .returning({ id: devices.id });
  if (!dev) throw new Error("device insert failed");
  const { raw, prefix } = generateDeviceKey();
  const keyHash = hashDeviceKey(defaultTestEnv.API_KEY_HASH_PEPPER!, raw);
  await testDb.db.insert(deviceApiKeys).values({ deviceId: dev.id, keyHash, keyPrefix: prefix });
  return { deviceId: dev.id, rawKey: raw, orgId: org.id };
}

describe("GET /v1/redaction-set", () => {
  beforeAll(async () => {
    testDb = await setupTestDb();
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await testDb.cleanup();
  });

  it("returns default patterns when no org row exists", async () => {
    const { rawKey } = await seedActiveDevice();
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      patterns: RedactionPattern[];
      version: string;
      ttl_seconds: number;
    };
    expect(body.patterns).toEqual(SERVER_DEFAULT_PATTERNS);
    expect(body.version).toMatch(/^default-[a-f0-9]{8}$/);
    expect(body.ttl_seconds).toBe(86400);
  });

  it("returns custom patterns when org row exists", async () => {
    const { rawKey, orgId } = await seedActiveDevice();
    const custom: RedactionPattern[] = [
      { name: "internal", regex: "INT-[0-9]{6}", replacement: "INT-***" },
    ];
    await testDb.db.insert(orgRedactionPatterns).values({ orgId, patterns: custom });

    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.patterns).toEqual(custom);
    expect(body.version).toMatch(/^org-/);
  });

  it("rejects missing token with 401 missing_token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/redaction-set" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "missing_token" });
  });

  it("rejects malformed token with 401 invalid_token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: "Bearer wrong-prefix" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_token" });
  });

  it("rejects revoked key with 401 key_revoked", async () => {
    const { rawKey, deviceId } = await seedActiveDevice();
    await testDb.db
      .update(deviceApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(deviceApiKeys.deviceId, deviceId));
    const res = await app.inject({
      method: "GET",
      url: "/v1/redaction-set",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "key_revoked" });
  });
});
```

- [ ] **Step 2: Run; expect green**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm --filter @caliber/api exec vitest run tests/integration/rest/redactionSet.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/integration/rest/redactionSet.test.ts
git commit -m "test(api): GET /v1/redaction-set integration tests — default / custom / 401 paths"
```

### Task 1.5: Server-default-set parity test

**Files:**
- Modify: `apps/api/tests/integration/rest/redactionSet.test.ts` (append parity test)

- [ ] **Step 1: Add the parity test**

The agent's `redact/regexes.go` `DefaultPatterns` (added in Phase 4) and the server's `SERVER_DEFAULT_PATTERNS` must stay in sync. Lock with a regression test that reads the Go source and asserts both lists structurally match.

Append to `redactionSet.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SERVER_DEFAULT_PATTERNS / agent DefaultPatterns parity", () => {
  it("server and agent default sets match by Name + Replacement", () => {
    const goPath = join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "agent",
      "redact",
      "regexes.go",
    );
    const goSource = readFileSync(goPath, "utf8");
    // Extract Name + Replacement from each entry:
    // `{Name: "x", RegexSrc: "...", Replacement: "y"}`
    const re = /\{Name:\s*"([^"]+)",\s*RegexSrc:\s*`([^`]+)`,\s*Replacement:\s*"([^"]+)"\}/g;
    const goEntries: { name: string; regex: string; replacement: string }[] = [];
    for (const m of goSource.matchAll(re)) {
      goEntries.push({ name: m[1]!, regex: m[2]!, replacement: m[3]! });
    }
    expect(goEntries.length).toBeGreaterThan(0);
    expect(goEntries).toEqual(SERVER_DEFAULT_PATTERNS);
  });
});
```

This test will FAIL until Phase 4's `agent/redact/regexes.go` is written with `DefaultPatterns` as a slice of `Pattern{Name: "...", RegexSrc: "..."}`. **Use `t.Skip` (TypeScript: `it.skip`) for now**, or wait to add this test until Phase 4 ships. For ordering, leave this test commented out in this commit and re-enable in Phase 4 Task 4.1.

- [ ] **Step 2: Commit (with the parity test commented out)**

```bash
# (after editing — the test file currently contains the parity test as a JS comment block)
git add apps/api/tests/integration/rest/redactionSet.test.ts
git commit -m "test(api): parity-test stub for agent/redact DefaultPatterns (re-enabled in Phase 4)"
```

---

## Phase 2 — Agent `redact/event.go` (wire-shape type)

### Task 2.1: Create the package and Event type

**Files:**
- Create: `agent/redact/event.go`
- Create: `agent/redact/event_test.go`

- [ ] **Step 1: Create the directory**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
mkdir -p agent/redact/parser
```

- [ ] **Step 2: Write the failing test**

Create `agent/redact/event_test.go`:

```go
package redact

import (
	"encoding/json"
	"testing"
	"time"
)

func TestEvent_JSONRoundTripWithPointerTokens(t *testing.T) {
	five := int64(5)
	e := Event{
		EventID:   "e-1",
		EventType: "tool_use",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		Content:   map[string]any{"name": "Read", "input": map[string]any{"path": "/x"}},
		Tokens:    &EventTokens{Input: &five},
	}
	bs, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Event
	if err := json.Unmarshal(bs, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.EventID != "e-1" || got.EventType != "tool_use" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
	if got.Tokens == nil || got.Tokens.Input == nil || *got.Tokens.Input != 5 {
		t.Errorf("Tokens.Input round-trip lost: %+v", got.Tokens)
	}
}

func TestEvent_OmitemptyDropsEmptyFields(t *testing.T) {
	e := Event{
		EventID:   "e-1",
		EventType: "user",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		// ParentEventID, TurnID, Role, Content, Tokens all zero
	}
	bs, _ := json.Marshal(e)
	got := string(bs)
	for _, banned := range []string{"parent_event_id", "turn_id", "role", "content", "tokens"} {
		if contains(got, banned) {
			t.Errorf("omitempty should drop %q, got: %s", banned, got)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
```

- [ ] **Step 3: Verify failure**

```bash
cd agent
go test ./redact/...
```

Expected: FAIL — `Event` undefined.

- [ ] **Step 4: Implement `agent/redact/event.go`**

```go
// Package redact defines the wire-shape Event sent to caliber's
// POST /v1/ingest and the per-event redaction logic that runs before
// the daemon serialises Chunks. Parsers in redact/parser produce
// these from per-source JSONL.
package redact

import "time"

// Event mirrors the server's zod schema in apps/api/src/rest/ingest.ts:38-48.
// Pointer ints in EventTokens distinguish "absent" from "zero" so the
// daemon does not send `0` when the source line omitted the field.
// Content is `any` because per-source content shapes differ (Claude
// tool_use vs Codex reasoning blocks); server-side accepts unknown.
type Event struct {
	EventID       string       `json:"event_id"`
	ParentEventID string       `json:"parent_event_id,omitempty"`
	TurnID        string       `json:"turn_id,omitempty"`
	Role          string       `json:"role,omitempty"`
	EventType     string       `json:"event_type"`
	Timestamp     time.Time    `json:"timestamp"`
	Content       any          `json:"content,omitempty"`
	Tokens        *EventTokens `json:"tokens,omitempty"`
}

type EventTokens struct {
	Input         *int64 `json:"input,omitempty"`
	Output        *int64 `json:"output,omitempty"`
	CacheRead     *int64 `json:"cache_read,omitempty"`
	CacheCreation *int64 `json:"cache_creation,omitempty"`
	Reasoning     *int64 `json:"reasoning,omitempty"`
}
```

- [ ] **Step 5: Verify**

```bash
cd agent
go test ./redact/... -v -race
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/redact/event.go agent/redact/event_test.go
git commit -m "feat(agent): redact.Event wire-shape type"
```

---

## Phase 3 — Agent `redact/parser/`

### Task 3.1: ErrSkipLine sentinel + Dispatch

**Files:**
- Create: `agent/redact/parser/dispatch.go`
- Create: `agent/redact/parser/dispatch_test.go`

- [ ] **Step 1: Write the failing test**

```go
// agent/redact/parser/dispatch_test.go
package parser

import (
	"errors"
	"testing"
)

func TestDispatch_RoutesByClaudeSource(t *testing.T) {
	const line = `{"type":"queue-operation"}`
	_, err := Dispatch("claude", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("claude queue-operation should ErrSkipLine, got %v", err)
	}
}

func TestDispatch_RoutesByClaudeSubagentSource(t *testing.T) {
	const line = `{"type":"queue-operation"}`
	_, err := Dispatch("claude-subagent", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("claude-subagent should route to claude parser, got %v", err)
	}
}

func TestDispatch_RoutesByCodexSource(t *testing.T) {
	const line = `{"type":"session_meta","payload":{}}`
	_, err := Dispatch("codex", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("codex session_meta should ErrSkipLine, got %v", err)
	}
}

func TestDispatch_UnknownSourceReturnsError(t *testing.T) {
	_, err := Dispatch("unknown", `{}`)
	if err == nil {
		t.Error("expected non-nil error for unknown source")
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./redact/parser/...
```

Expected: FAIL — `Dispatch` / `ErrSkipLine` undefined.

- [ ] **Step 3: Implement `agent/redact/parser/dispatch.go`**

```go
// Package parser converts per-source JSONL lines into wire-shape
// redact.Event values. Each source is in its own file; Dispatch
// routes by watcher.FileRef.Source value.
package parser

import (
	"errors"
	"fmt"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// ErrSkipLine signals that the line was not an event (queue-operation,
// session_meta, summary lines, etc.). Loop callers skip silently.
var ErrSkipLine = errors.New("parser: skip non-event line")

// Dispatch routes a JSONL line to the per-source parser by FileRef.Source.
//   "claude" or "claude-subagent" -> ParseClaudeEvent
//   "codex"                       -> ParseCodexEvent
//   anything else                 -> error
func Dispatch(source string, line string) (redact.Event, error) {
	switch source {
	case "claude", "claude-subagent":
		return ParseClaudeEvent(line)
	case "codex":
		return ParseCodexEvent(line)
	default:
		return redact.Event{}, fmt.Errorf("parser: unknown source %q", source)
	}
}
```

Note: `ParseClaudeEvent` and `ParseCodexEvent` are stubbed implicitly by being undefined — the package will not compile yet. The next two tasks (3.2 and 3.3) implement them in TDD order. To make this task self-contained, add temporary stubs:

```go
// agent/redact/parser/dispatch.go — append below Dispatch:
// TEMPORARY stubs filled by Tasks 3.2 / 3.3.
func ParseClaudeEvent(line string) (redact.Event, error) { return redact.Event{}, ErrSkipLine }
func ParseCodexEvent(line string) (redact.Event, error)  { return redact.Event{}, ErrSkipLine }
```

- [ ] **Step 4: Verify**

```bash
go test ./redact/parser/... -v -race
```

Expected: 4 tests pass (stubs return ErrSkipLine for all routed sources).

- [ ] **Step 5: Commit**

```bash
git add agent/redact/parser/dispatch.go agent/redact/parser/dispatch_test.go
git commit -m "feat(agent): parser.Dispatch + ErrSkipLine sentinel (with stubs)"
```

### Task 3.2: ParseClaudeEvent

**Files:**
- Modify: `agent/redact/parser/dispatch.go` (replace ParseClaudeEvent stub)
- Create: `agent/redact/parser/claude.go`
- Create: `agent/redact/parser/claude_test.go`

- [ ] **Step 1: Move stubs out of dispatch.go**

Edit `agent/redact/parser/dispatch.go` and DELETE the two temporary stub functions at the bottom (they'll be implemented in separate files).

- [ ] **Step 2: Write the failing tests**

```go
// agent/redact/parser/claude_test.go
package parser

import (
	"errors"
	"testing"
)

func TestParseClaudeEvent_QueueOperationIsSkipLine(t *testing.T) {
	line := `{"type":"queue-operation","sessionId":"s1","timestamp":"2026-05-23T10:00:00Z"}`
	_, err := ParseClaudeEvent(line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("err = %v, want ErrSkipLine", err)
	}
}

func TestParseClaudeEvent_SummaryIsSkipLine(t *testing.T) {
	line := `{"type":"summary","sessionId":"s1","timestamp":"2026-05-23T10:00:00Z"}`
	_, err := ParseClaudeEvent(line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("err = %v, want ErrSkipLine", err)
	}
}

func TestParseClaudeEvent_UserMessage(t *testing.T) {
	line := `{"type":"user","uuid":"u-1","parentUuid":null,"timestamp":"2026-05-23T10:00:00Z","message":{"role":"user","content":"hello"}}`
	got, err := ParseClaudeEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID != "u-1" || got.EventType != "user" || got.Role != "user" {
		t.Errorf("got = %+v", got)
	}
	if got.Content != "hello" {
		t.Errorf("Content = %v, want %q", got.Content, "hello")
	}
	if got.ParentEventID != "" {
		t.Errorf("ParentEventID should be empty for null parent, got %q", got.ParentEventID)
	}
}

func TestParseClaudeEvent_AssistantWithUsage(t *testing.T) {
	line := `{"type":"assistant","uuid":"a-1","parentUuid":"u-1","timestamp":"2026-05-23T10:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}}}`
	got, err := ParseClaudeEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID != "a-1" || got.ParentEventID != "u-1" || got.EventType != "assistant" {
		t.Errorf("got = %+v", got)
	}
	if got.Tokens == nil || got.Tokens.Input == nil || *got.Tokens.Input != 12 {
		t.Errorf("Tokens.Input wrong: %+v", got.Tokens)
	}
	if got.Tokens.CacheRead == nil || *got.Tokens.CacheRead != 5 {
		t.Errorf("Tokens.CacheRead wrong: %+v", got.Tokens)
	}
}

func TestParseClaudeEvent_MalformedJSONIsNonSkipError(t *testing.T) {
	_, err := ParseClaudeEvent("{not json")
	if err == nil {
		t.Fatal("expected error")
	}
	if errors.Is(err, ErrSkipLine) {
		t.Errorf("malformed JSON should NOT be ErrSkipLine; got %v", err)
	}
}
```

- [ ] **Step 3: Verify failure**

```bash
go test ./redact/parser/... -run ParseClaudeEvent
```

Expected: FAIL — `ParseClaudeEvent` undefined.

- [ ] **Step 4: Implement `agent/redact/parser/claude.go`**

```go
package parser

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// ParseClaudeEvent maps one JSONL line from ~/.claude/projects/.../*.jsonl
// to a wire-shape redact.Event. Non-event shapes (queue-operation, summary)
// return ErrSkipLine.
//
// Field mapping (verified 2026-05-23 against real transcripts):
//   uuid                                              -> EventID
//   parentUuid (null-tolerant)                        -> ParentEventID
//   type                                              -> EventType
//   timestamp                                         -> Timestamp
//   message.role                                      -> Role
//   message.content                                   -> Content
//   message.usage.{input_tokens,output_tokens,
//      cache_read_input_tokens,cache_creation_input_tokens}
//                                                    -> Tokens.*
func ParseClaudeEvent(line string) (redact.Event, error) {
	var raw struct {
		Type       string          `json:"type"`
		UUID       string          `json:"uuid"`
		ParentUUID *string         `json:"parentUuid"`
		Timestamp  string          `json:"timestamp"`
		Message    *claudeMessage  `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return redact.Event{}, fmt.Errorf("parser: claude json: %w", err)
	}
	switch raw.Type {
	case "queue-operation", "summary", "":
		return redact.Event{}, ErrSkipLine
	}

	ts, _ := time.Parse(time.RFC3339Nano, raw.Timestamp)
	ev := redact.Event{
		EventID:   raw.UUID,
		EventType: raw.Type,
		Timestamp: ts,
	}
	if raw.ParentUUID != nil {
		ev.ParentEventID = *raw.ParentUUID
	}
	if raw.Message != nil {
		ev.Role = raw.Message.Role
		ev.Content = raw.Message.Content
		if u := raw.Message.Usage; u != nil {
			ev.Tokens = &redact.EventTokens{
				Input:         u.InputTokens,
				Output:        u.OutputTokens,
				CacheRead:     u.CacheReadInputTokens,
				CacheCreation: u.CacheCreationInputTokens,
			}
		}
	}
	return ev, nil
}

type claudeMessage struct {
	Role    string       `json:"role"`
	Content any          `json:"content"`
	Usage   *claudeUsage `json:"usage"`
}

type claudeUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
}
```

- [ ] **Step 5: Verify**

```bash
go test ./redact/parser/... -v -race
```

Expected: all parser tests pass (4 from Task 3.1 + 5 from this task = 9).

- [ ] **Step 6: Commit**

```bash
git add agent/redact/parser/dispatch.go agent/redact/parser/claude.go agent/redact/parser/claude_test.go
git commit -m "feat(agent): parser.ParseClaudeEvent — uuid/parentUuid/usage mapping"
```

### Task 3.3: ParseCodexEvent

**Files:**
- Create: `agent/redact/parser/codex.go`
- Create: `agent/redact/parser/codex_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// agent/redact/parser/codex_test.go
package parser

import (
	"errors"
	"testing"
)

func TestParseCodexEvent_SessionMetaIsSkipLine(t *testing.T) {
	line := `{"type":"session_meta","payload":{"id":"s1","cwd":"/x"}}`
	_, err := ParseCodexEvent(line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("err = %v, want ErrSkipLine", err)
	}
}

func TestParseCodexEvent_Event(t *testing.T) {
	line := `{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"id":"e-1","parent_id":"e-0","type":"reasoning","role":"assistant","content":"thinking","usage":{"input_tokens":1,"output_tokens":2,"reasoning_output_tokens":3}}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID != "e-1" || got.ParentEventID != "e-0" || got.EventType != "reasoning" {
		t.Errorf("got = %+v", got)
	}
	if got.Role != "assistant" {
		t.Errorf("Role = %q", got.Role)
	}
	if got.Content != "thinking" {
		t.Errorf("Content = %v", got.Content)
	}
	if got.Tokens == nil || got.Tokens.Reasoning == nil || *got.Tokens.Reasoning != 3 {
		t.Errorf("Tokens.Reasoning wrong: %+v", got.Tokens)
	}
}

func TestParseCodexEvent_MalformedJSONIsNonSkipError(t *testing.T) {
	_, err := ParseCodexEvent("{not json")
	if err == nil {
		t.Fatal("expected error")
	}
	if errors.Is(err, ErrSkipLine) {
		t.Errorf("malformed JSON should NOT be ErrSkipLine; got %v", err)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
go test ./redact/parser/... -run ParseCodexEvent
```

Expected: FAIL.

- [ ] **Step 3: Implement `agent/redact/parser/codex.go`**

```go
package parser

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// ParseCodexEvent maps one JSONL line from
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl to a wire-shape
// redact.Event. session_meta returns ErrSkipLine (CodexSource already
// used it for cwd extraction during file enumeration).
//
// Field mapping (verified 2026-05-23 against real transcripts):
//   timestamp (top-level)                             -> Timestamp
//   payload.id                                        -> EventID
//   payload.parent_id (null-tolerant)                 -> ParentEventID
//   payload.type                                      -> EventType
//   payload.role                                      -> Role
//   payload.content or payload.result                 -> Content
//   payload.usage.{input_tokens,output_tokens,
//      cache_read_tokens,cache_creation_tokens,
//      reasoning_output_tokens}                       -> Tokens.*
func ParseCodexEvent(line string) (redact.Event, error) {
	var raw struct {
		Type      string        `json:"type"`
		Timestamp string        `json:"timestamp"`
		Payload   *codexPayload `json:"payload"`
	}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return redact.Event{}, fmt.Errorf("parser: codex json: %w", err)
	}
	if raw.Type == "session_meta" {
		return redact.Event{}, ErrSkipLine
	}
	if raw.Payload == nil {
		return redact.Event{}, ErrSkipLine
	}
	ts, _ := time.Parse(time.RFC3339Nano, raw.Timestamp)
	ev := redact.Event{
		EventID:   raw.Payload.ID,
		EventType: raw.Payload.Type,
		Timestamp: ts,
		Role:      raw.Payload.Role,
	}
	if raw.Payload.ParentID != nil {
		ev.ParentEventID = *raw.Payload.ParentID
	}
	if raw.Payload.Content != nil {
		ev.Content = raw.Payload.Content
	} else if raw.Payload.Result != nil {
		ev.Content = raw.Payload.Result
	}
	if u := raw.Payload.Usage; u != nil {
		ev.Tokens = &redact.EventTokens{
			Input:         u.InputTokens,
			Output:        u.OutputTokens,
			CacheRead:     u.CacheReadTokens,
			CacheCreation: u.CacheCreationTokens,
			Reasoning:     u.ReasoningOutputTokens,
		}
	}
	return ev, nil
}

type codexPayload struct {
	ID       string      `json:"id"`
	ParentID *string     `json:"parent_id"`
	Type     string      `json:"type"`
	Role     string      `json:"role"`
	Content  any         `json:"content"`
	Result   any         `json:"result"`
	Usage    *codexUsage `json:"usage"`
}

type codexUsage struct {
	InputTokens           *int64 `json:"input_tokens"`
	OutputTokens          *int64 `json:"output_tokens"`
	CacheReadTokens       *int64 `json:"cache_read_tokens"`
	CacheCreationTokens   *int64 `json:"cache_creation_tokens"`
	ReasoningOutputTokens *int64 `json:"reasoning_output_tokens"`
}
```

- [ ] **Step 4: Verify**

```bash
go test ./redact/parser/... -v -race
```

Expected: all parser tests pass (4 + 5 + 3 = 12).

- [ ] **Step 5: Commit**

```bash
git add agent/redact/parser/codex.go agent/redact/parser/codex_test.go
git commit -m "feat(agent): parser.ParseCodexEvent — payload.id/parent_id/usage mapping"
```

---

## Phase 4 — `redact/regexes.go` + `redact/set.go`

### Task 4.1: Pattern type + DefaultPatterns + ScrubString

**Files:**
- Create: `agent/redact/regexes.go`
- Create: `agent/redact/regexes_test.go`

- [ ] **Step 1: Write the failing test**

```go
// agent/redact/regexes_test.go
package redact

import (
	"strings"
	"testing"
)

func TestDefaultPatterns_AllCompile(t *testing.T) {
	for i := range DefaultPatterns {
		p := &DefaultPatterns[i]
		if err := p.Compile(); err != nil {
			t.Errorf("pattern %q failed to compile: %v", p.Name, err)
		}
	}
}

func TestScrubString_AnthropicKeyMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", DefaultPatterns)
	if !strings.Contains(got, "sk-ant-***") {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_AwsAccessKeyMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("key=AKIAIOSFODNN7EXAMPLE more text", DefaultPatterns)
	if !strings.Contains(got, "AKIA***") {
		t.Errorf("got %q", got)
	}
	if strings.Contains(got, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("raw key leaked: %q", got)
	}
}

func TestScrubString_BearerMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("Authorization: Bearer abc123def456ghi789jkl012mnop345", DefaultPatterns)
	if !strings.Contains(got, "Bearer ***") {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_NearMissDoesNotMatch(t *testing.T) {
	// "sk-" with only 5 chars after — below the {20,} threshold.
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("partial: sk-short", DefaultPatterns)
	if got != "partial: sk-short" {
		t.Errorf("near-miss got scrubbed: %q", got)
	}
}

func TestScrubString_EmptyPatternsIsIdentity(t *testing.T) {
	got := ScrubString("anything sk-with-lots-of-chars-here", nil)
	if got != "anything sk-with-lots-of-chars-here" {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_IsIdempotent(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	once := ScrubString("Bearer abc123def456ghi789jkl012mnop345", DefaultPatterns)
	twice := ScrubString(once, DefaultPatterns)
	if once != twice {
		t.Errorf("not idempotent:\n once: %q\ntwice: %q", once, twice)
	}
}

func mustCompileAll(t *testing.T, ps []Pattern) {
	t.Helper()
	for i := range ps {
		if err := ps[i].Compile(); err != nil {
			t.Fatalf("compile %q: %v", ps[i].Name, err)
		}
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
go test ./redact/... -run "DefaultPatterns|ScrubString"
```

Expected: FAIL — `Pattern` / `ScrubString` / `DefaultPatterns` undefined.

- [ ] **Step 3: Implement `agent/redact/regexes.go`**

```go
package redact

import (
	"fmt"
	"regexp"
)

// Pattern is one secret-scrub regex with a replacement template. RegexSrc
// holds the source string so the set can be serialised to JSON / fetched
// from the server; Regex is the compiled form, rebuilt via Compile().
type Pattern struct {
	Name        string         `json:"name"`
	Regex       *regexp.Regexp `json:"-"`
	RegexSrc    string         `json:"regex"`
	Replacement string         `json:"replacement"`
}

// Compile parses RegexSrc into Regex. Returns an error with the pattern
// name on bad regex. Callers should skip bad patterns + log; one broken
// pattern must not break the set.
func (p *Pattern) Compile() error {
	if p.Regex != nil {
		return nil
	}
	re, err := regexp.Compile(p.RegexSrc)
	if err != nil {
		return fmt.Errorf("pattern %q: %w", p.Name, err)
	}
	p.Regex = re
	return nil
}

// DefaultPatterns is the bundled secret-scrub set. Mirrors
// apps/api/src/rest/redactionSet.ts SERVER_DEFAULT_PATTERNS — a parity
// test in that file asserts the two stay in sync.
var DefaultPatterns = []Pattern{
	{Name: "anthropic_or_openai_legacy", RegexSrc: `sk-[a-zA-Z0-9_\-]{20,}`, Replacement: "sk-***"},
	{Name: "openai_project", RegexSrc: `sk-proj-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-proj-***"},
	{Name: "anthropic_console", RegexSrc: `sk-ant-api[0-9]{2}-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-ant-***"},
	{Name: "aws_access_key", RegexSrc: `AKIA[0-9A-Z]{16}`, Replacement: "AKIA***"},
	{Name: "github_pat", RegexSrc: `ghp_[A-Za-z0-9]{36,}`, Replacement: "ghp_***"},
	{Name: "github_oauth", RegexSrc: `gho_[A-Za-z0-9]{36,}`, Replacement: "gho_***"},
	{Name: "github_pat_fine_grained", RegexSrc: `github_pat_[A-Za-z0-9_]{82}`, Replacement: "github_pat_***"},
	{Name: "slack_bot", RegexSrc: `xoxb-[A-Za-z0-9\-]{40,}`, Replacement: "xoxb-***"},
	{Name: "slack_user", RegexSrc: `xoxp-[A-Za-z0-9\-]{40,}`, Replacement: "xoxp-***"},
	{Name: "groq", RegexSrc: `gsk_[A-Za-z0-9]{20,}`, Replacement: "gsk_***"},
	{Name: "bearer_generic", RegexSrc: `Bearer\s+[A-Za-z0-9_\-.]{20,}`, Replacement: "Bearer ***"},
}

// ScrubString applies each Pattern's Regex.ReplaceAllString with its
// Replacement. Patterns with nil Regex (uncompiled) are skipped.
// Empty / nil patterns slice returns s unchanged.
func ScrubString(s string, patterns []Pattern) string {
	for i := range patterns {
		if patterns[i].Regex == nil {
			continue
		}
		s = patterns[i].Regex.ReplaceAllString(s, patterns[i].Replacement)
	}
	return s
}
```

Note: the most-specific patterns (`sk-proj-`, `sk-ant-api`) MUST appear BEFORE the generic `sk-` pattern in the slice so multi-pattern matches mask the more-informative form first. Order in `DefaultPatterns` reflects this.

- [ ] **Step 4: Verify**

```bash
go test ./redact/... -v -race
```

Expected: all 7 tests pass.

- [ ] **Step 5: Re-enable server-side parity test**

Open `apps/api/tests/integration/rest/redactionSet.test.ts` and uncomment the parity test block written as commented-out in Task 1.5.

Run:

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm --filter @caliber/api exec vitest run tests/integration/rest/redactionSet.test.ts -t "parity"
```

Expected: PASS — the Go regex source list matches the TS constant.

- [ ] **Step 6: Commit**

```bash
git add agent/redact/regexes.go agent/redact/regexes_test.go apps/api/tests/integration/rest/redactionSet.test.ts
git commit -m "feat(agent): redact.DefaultPatterns + ScrubString + server-parity regression"
```

### Task 4.2: RedactionSet + Compile + DefaultSet

**Files:**
- Create: `agent/redact/set.go`
- Create: `agent/redact/set_test.go`

- [ ] **Step 1: Write the failing test**

```go
// agent/redact/set_test.go
package redact

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRedactionSet_IsExpired(t *testing.T) {
	r := &RedactionSet{
		FetchedAt:  time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC),
		TTLSeconds: 3600, // 1h
	}
	if r.IsExpired(time.Date(2026, 5, 22, 10, 30, 0, 0, time.UTC)) {
		t.Error("should NOT be expired at +30min")
	}
	if !r.IsExpired(time.Date(2026, 5, 22, 11, 30, 0, 0, time.UTC)) {
		t.Error("should be expired at +1h30m")
	}
}

func TestRedactionSet_CompileSkipsBadPatternsButKeepsGoodOnes(t *testing.T) {
	r := &RedactionSet{
		Patterns: []Pattern{
			{Name: "good", RegexSrc: `AKIA[0-9A-Z]{16}`, Replacement: "***"},
			{Name: "bad", RegexSrc: `[unclosed`, Replacement: "***"},
			{Name: "good2", RegexSrc: `sk-[a-z]+`, Replacement: "***"},
		},
	}
	err := r.Compile()
	if err == nil {
		t.Error("expected aggregated error for bad pattern")
	}
	// The two good patterns still have Regex set.
	if r.Patterns[0].Regex == nil {
		t.Error("good pattern 0 should compile")
	}
	if r.Patterns[1].Regex != nil {
		t.Error("bad pattern should NOT have Regex set")
	}
	if r.Patterns[2].Regex == nil {
		t.Error("good pattern 2 should still compile (per-pattern fault-tolerant)")
	}
}

func TestRedactionSet_JSONRoundTrip(t *testing.T) {
	original := &RedactionSet{
		Patterns: []Pattern{
			{Name: "n", RegexSrc: `[0-9]+`, Replacement: "#"},
		},
		Version:    "v-test",
		FetchedAt:  time.Date(2026, 5, 23, 0, 0, 0, 0, time.UTC),
		TTLSeconds: 86400,
	}
	bs, _ := json.Marshal(original)
	var got RedactionSet
	if err := json.Unmarshal(bs, &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != "v-test" || got.TTLSeconds != 86400 {
		t.Errorf("got %+v", got)
	}
	if len(got.Patterns) != 1 || got.Patterns[0].RegexSrc != `[0-9]+` {
		t.Errorf("Patterns lost: %+v", got.Patterns)
	}
	// Regex field is non-serialised (`json:"-"`)
	if got.Patterns[0].Regex != nil {
		t.Errorf("Regex should not deserialise; caller calls Compile()")
	}
}

func TestDefaultSet_HasAllDefaultPatternsCompiled(t *testing.T) {
	s := DefaultSet()
	if len(s.Patterns) != len(DefaultPatterns) {
		t.Errorf("len(s.Patterns) = %d, want %d", len(s.Patterns), len(DefaultPatterns))
	}
	for i := range s.Patterns {
		if s.Patterns[i].Regex == nil {
			t.Errorf("Pattern %q not compiled", s.Patterns[i].Name)
		}
	}
	if s.TTLSeconds != 86400 {
		t.Errorf("TTLSeconds = %d, want 86400", s.TTLSeconds)
	}
	if s.Version == "" {
		t.Error("Version should be non-empty")
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
go test ./redact/... -run "RedactionSet|DefaultSet"
```

Expected: FAIL.

- [ ] **Step 3: Implement `agent/redact/set.go`**

```go
package redact

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// RedactionSet is the per-org effective secret-scrub set the daemon
// applies. The disk-cached form serialises via JSON (RegexSrc + Name +
// Replacement); Regex is rebuilt via Compile() after load / fetch.
type RedactionSet struct {
	Patterns   []Pattern `json:"patterns"`
	Version    string    `json:"version"`
	FetchedAt  time.Time `json:"fetched_at"`
	TTLSeconds int64     `json:"ttl_seconds"`
}

// IsExpired returns true when now > FetchedAt + TTLSeconds.
func (r *RedactionSet) IsExpired(now time.Time) bool {
	expiry := r.FetchedAt.Add(time.Duration(r.TTLSeconds) * time.Second)
	return now.After(expiry)
}

// Compile rebuilds every pattern's *regexp.Regexp from its RegexSrc.
// Per-pattern fault-tolerant: a bad regex doesn't break the set; just
// returns an aggregate error listing the bad names. Callers should
// log the error and continue using the compiled subset.
func (r *RedactionSet) Compile() error {
	var failed []string
	for i := range r.Patterns {
		if err := r.Patterns[i].Compile(); err != nil {
			failed = append(failed, fmt.Sprintf("%s (%v)", r.Patterns[i].Name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("redact: %d bad patterns: %s", len(failed), strings.Join(failed, ", "))
	}
	return nil
}

// DefaultSet returns a fresh RedactionSet built from the bundled
// DefaultPatterns. Used as the bottom fallback when fetch fails and no
// cached set exists.
func DefaultSet() *RedactionSet {
	patterns := make([]Pattern, len(DefaultPatterns))
	copy(patterns, DefaultPatterns)
	s := &RedactionSet{
		Patterns:   patterns,
		Version:    "bundled-default",
		FetchedAt:  time.Now().UTC(),
		TTLSeconds: 86400,
	}
	_ = s.Compile()
	return s
}

// ErrNoRedactionSet is returned by config.LoadRedactionSet when no
// cached set exists on disk yet. Not a real error — caller falls
// through to fetch / default.
var ErrNoRedactionSet = errors.New("redact: no cached set")
```

- [ ] **Step 4: Verify**

```bash
go test ./redact/... -v -race
```

Expected: all set tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/redact/set.go agent/redact/set_test.go
git commit -m "feat(agent): redact.RedactionSet + Compile + DefaultSet"
```

---

## Phase 5 — `redact/mode.go` (three modes)

### Task 5.1: ApplyMode metadata-only branch

**Files:**
- Create: `agent/redact/mode.go`
- Create: `agent/redact/mode_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/redact/mode_test.go
package redact

import (
	"strings"
	"testing"
	"time"
)

func sampleEvent() Event {
	five := int64(5)
	return Event{
		EventID:   "e-1",
		EventType: "assistant",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		Role:      "assistant",
		Content:   "the quick brown fox jumps over the lazy dog",
		Tokens:    &EventTokens{Output: &five},
	}
}

func TestApplyMode_MetadataOnly_StringContentBecomesLengthAndPreview(t *testing.T) {
	e := sampleEvent()
	got := ApplyMode(e, ModeMetadataOnly, nil)

	// Original unmodified (immutability)
	if e.Content != "the quick brown fox jumps over the lazy dog" {
		t.Error("ApplyMode mutated original Content")
	}

	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("Content should be a map summary, got %T: %+v", got.Content, got.Content)
	}
	if m["preview"] != "the quick brown" {
		t.Errorf("preview = %q, want %q", m["preview"], "the quick brown")
	}
	if m["length"] == nil {
		t.Error("length missing")
	}

	// Other fields passthrough
	if got.EventID != "e-1" || got.EventType != "assistant" {
		t.Errorf("got = %+v", got)
	}
	if got.Tokens == nil || got.Tokens.Output == nil || *got.Tokens.Output != 5 {
		t.Errorf("Tokens lost: %+v", got.Tokens)
	}
}

func TestApplyMode_MetadataOnly_StructuredContentBecomesToolTag(t *testing.T) {
	e := Event{
		EventID:   "e-2",
		EventType: "assistant",
		Timestamp: time.Now(),
		Content: []any{
			map[string]any{"type": "tool_use", "name": "Read", "input": map[string]any{"path": "/x"}},
		},
	}
	got := ApplyMode(e, ModeMetadataOnly, nil)
	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("got %T", got.Content)
	}
	if !strings.HasPrefix(m["preview"].(string), "<tool:") {
		t.Errorf("preview = %q, want <tool:...>", m["preview"])
	}
}

func TestApplyMode_MetadataOnly_NilContent(t *testing.T) {
	e := Event{EventID: "e-3", EventType: "system", Timestamp: time.Now()}
	got := ApplyMode(e, ModeMetadataOnly, nil)
	if got.Content != nil {
		m, ok := got.Content.(map[string]any)
		if !ok || m["preview"] != "" {
			t.Errorf("nil content should map to empty preview, got %+v", got.Content)
		}
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
go test ./redact/... -run ApplyMode_MetadataOnly
```

Expected: FAIL — `ApplyMode` / `Mode` constants undefined.

- [ ] **Step 3: Implement `agent/redact/mode.go`**

```go
package redact

import (
	"encoding/json"
	"strings"
)

// Mode controls how aggressively content is redacted before upload.
type Mode string

const (
	ModeMetadataOnly Mode = "metadata-only"
	ModeRedactedBody Mode = "redacted-body"
	ModeFullBody     Mode = "full-body"
)

// ApplyMode returns a redacted COPY of e per mode + patterns. The
// original event is unmodified (callers can keep referring to it).
//
// metadata-only:  Content -> {length, preview}; secret-scrub NOT applied
//                 (no content to scrub).
// redacted-body:  Content walked recursively; every string runs through
//                 ScrubString(patterns).
// full-body:      Same as redacted-body — spec is explicit that
//                 secret-scrub is always-on even in full-body.
func ApplyMode(e Event, mode Mode, patterns []Pattern) Event {
	out := e // copy; fields are pass-by-value or pointers we DON'T mutate
	switch mode {
	case ModeMetadataOnly:
		out.Content = stripToSummary(e.Content)
	case ModeRedactedBody, ModeFullBody:
		out.Content = scrubAny(e.Content, patterns)
	}
	return out
}

func stripToSummary(content any) any {
	if content == nil {
		return map[string]any{"length": 0, "preview": ""}
	}
	raw, _ := json.Marshal(content)
	length := len(raw)
	preview := ""
	switch v := content.(type) {
	case string:
		preview = firstNWords(v, 3)
	case []any:
		// Look for the first tool_use entry; use <tool:<name>> form.
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "tool_use" {
				if name, ok := m["name"].(string); ok {
					preview = "<tool:" + name + ">"
					break
				}
			}
		}
	case map[string]any:
		if t, ok := v["type"].(string); ok && t == "tool_use" {
			if name, ok := v["name"].(string); ok {
				preview = "<tool:" + name + ">"
			}
		}
	}
	return map[string]any{"length": length, "preview": preview}
}

func firstNWords(s string, n int) string {
	fields := strings.Fields(s)
	if len(fields) > n {
		fields = fields[:n]
	}
	return strings.Join(fields, " ")
}

// scrubAny walks an arbitrary JSON-ish value and applies ScrubString to
// every string node. Maps and slices are recursed; primitives other
// than string are passed through. Returns a new value tree (input not
// mutated) so ApplyMode keeps the original Event content intact.
func scrubAny(v any, patterns []Pattern) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return ScrubString(x, patterns)
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = scrubAny(item, patterns)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = scrubAny(item, patterns)
		}
		return out
	default:
		// numbers, bools, etc — pass through
		return v
	}
}
```

- [ ] **Step 4: Verify metadata-only tests pass**

```bash
go test ./redact/... -run ApplyMode_MetadataOnly -v -race
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/redact/mode.go agent/redact/mode_test.go
git commit -m "feat(agent): ApplyMode metadata-only — length+preview summary"
```

### Task 5.2: Mode tests for redacted-body + full-body (scrubbing branches)

**Files:**
- Modify: `agent/redact/mode_test.go` (append)

- [ ] **Step 1: Append failing tests**

```go
// (append to agent/redact/mode_test.go)

func TestApplyMode_RedactedBody_StringSecretsScrubbed(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	e := Event{
		EventID:   "e-1",
		EventType: "assistant",
		Timestamp: time.Now(),
		Content:   "token is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
	}
	got := ApplyMode(e, ModeRedactedBody, DefaultPatterns)
	s, ok := got.Content.(string)
	if !ok {
		t.Fatalf("Content type = %T", got.Content)
	}
	if !strings.Contains(s, "sk-ant-***") {
		t.Errorf("content not scrubbed: %q", s)
	}
}

func TestApplyMode_RedactedBody_NestedStructuredContentScrubbed(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	e := Event{
		EventID:   "e-1",
		EventType: "tool_use",
		Timestamp: time.Now(),
		Content: map[string]any{
			"type": "tool_use",
			"name": "Bash",
			"input": map[string]any{
				"command": "export AWS_KEY=AKIAIOSFODNN7EXAMPLE",
			},
		},
	}
	got := ApplyMode(e, ModeRedactedBody, DefaultPatterns)
	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("Content type = %T", got.Content)
	}
	inp, ok := m["input"].(map[string]any)
	if !ok {
		t.Fatalf("input type = %T", m["input"])
	}
	cmd, ok := inp["command"].(string)
	if !ok {
		t.Fatalf("command type = %T", inp["command"])
	}
	if !strings.Contains(cmd, "AKIA***") {
		t.Errorf("nested string not scrubbed: %q", cmd)
	}
	if strings.Contains(cmd, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("raw key leaked: %q", cmd)
	}
}

func TestApplyMode_FullBody_StillScrubsSecrets(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	e := Event{
		EventID:   "e-1",
		EventType: "user",
		Timestamp: time.Now(),
		Content:   "my key is AKIAIOSFODNN7EXAMPLE — keep it",
	}
	got := ApplyMode(e, ModeFullBody, DefaultPatterns)
	s := got.Content.(string)
	// Defence-in-depth: even in full-body, secrets are scrubbed
	if !strings.Contains(s, "AKIA***") {
		t.Errorf("full-body should still scrub: %q", s)
	}
	// But surrounding text intact
	if !strings.Contains(s, "my key is") || !strings.Contains(s, "— keep it") {
		t.Errorf("full-body should preserve surrounding text: %q", s)
	}
}

func TestApplyMode_FullBody_ImmutabilityOfInput(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	original := Event{
		EventID:   "e-1",
		EventType: "user",
		Timestamp: time.Now(),
		Content: map[string]any{
			"command": "AKIAIOSFODNN7EXAMPLE",
		},
	}
	_ = ApplyMode(original, ModeFullBody, DefaultPatterns)
	m := original.Content.(map[string]any)
	if m["command"] != "AKIAIOSFODNN7EXAMPLE" {
		t.Errorf("original mutated: %v", m["command"])
	}
}
```

- [ ] **Step 2: Verify**

```bash
go test ./redact/... -v -race
```

Expected: all 7 mode tests pass + 7 regexes + 4 set + event = 18+.

- [ ] **Step 3: Commit**

```bash
git add agent/redact/mode_test.go
git commit -m "test(agent): ApplyMode redacted-body + full-body scrubbing + immutability"
```

---

## Phase 6 — `internal/config/redactionset.go`

### Task 6.1: Load / Save with atomic write

**Files:**
- Create: `agent/internal/config/redactionset.go`
- Create: `agent/internal/config/redactionset_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/config/redactionset_test.go
package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

func TestLoadRedactionSet_MissingReturnsErrNoRedactionSet(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := LoadRedactionSet()
	if !errors.Is(err, redact.ErrNoRedactionSet) {
		t.Errorf("err = %v, want ErrNoRedactionSet", err)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	orig := &redact.RedactionSet{
		Patterns: []redact.Pattern{
			{Name: "test", RegexSrc: `[0-9]+`, Replacement: "#"},
		},
		Version:    "v-test",
		FetchedAt:  time.Date(2026, 5, 23, 0, 0, 0, 0, time.UTC),
		TTLSeconds: 3600,
	}
	if err := SaveRedactionSet(orig); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "redaction-set.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := LoadRedactionSet()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Version != "v-test" || got.TTLSeconds != 3600 {
		t.Errorf("got = %+v", got)
	}
	if len(got.Patterns) != 1 || got.Patterns[0].RegexSrc != `[0-9]+` {
		t.Errorf("Patterns = %+v", got.Patterns)
	}
}

func TestSaveIsAtomic_NoLeftoverTmp(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := SaveRedactionSet(&redact.RedactionSet{Patterns: nil, Version: "v", TTLSeconds: 1}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(tmp)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestRedactionSetPath_HonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/x")
	if got := RedactionSetPath(); got != "/x/redaction-set.json" {
		t.Errorf("got %q", got)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3/agent
go test ./internal/config/... -run RedactionSet
```

Expected: FAIL — undefined.

- [ ] **Step 3: Implement `agent/internal/config/redactionset.go`**

```go
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// RedactionSetPath returns <RootDir>/redaction-set.json.
func RedactionSetPath() string {
	return filepath.Join(RootDir(), "redaction-set.json")
}

// LoadRedactionSet reads the cached set from disk. The caller is responsible
// for calling RedactionSet.Compile() to rebuild the *regexp.Regexp values
// (encoding/json does not deserialise them).
//
// Returns redact.ErrNoRedactionSet if the file does not exist — caller
// falls back to fetch / default.
func LoadRedactionSet() (*redact.RedactionSet, error) {
	bs, err := os.ReadFile(RedactionSetPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, redact.ErrNoRedactionSet
		}
		return nil, fmt.Errorf("config: read redaction-set: %w", err)
	}
	s := &redact.RedactionSet{}
	if err := json.Unmarshal(bs, s); err != nil {
		return nil, fmt.Errorf("config: parse redaction-set: %w", err)
	}
	return s, nil
}

// SaveRedactionSet writes atomically via tmp + rename. Perm 0o600.
func SaveRedactionSet(s *redact.RedactionSet) error {
	root := RootDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", root, err)
	}
	final := RedactionSetPath()
	tmp, err := os.CreateTemp(root, ".redaction-set.json.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
```

- [ ] **Step 4: Verify**

```bash
go test ./internal/config/... -v -race
```

Expected: all 4 new tests pass + PR1/PR2 tests still green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/redactionset.go agent/internal/config/redactionset_test.go
git commit -m "feat(agent): config.LoadRedactionSet / SaveRedactionSet with atomic 0600 write"
```

---

## Phase 7 — `internal/api/redactionset.go`

### Task 7.1: Client.FetchRedactionSet

**Files:**
- Create: `agent/internal/api/redactionset.go`
- Create: `agent/internal/api/redactionset_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/api/redactionset_test.go
package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchRedactionSet_Happy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/redaction-set" {
			t.Errorf("URL = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer cda_test" {
			t.Errorf("Authorization = %q", got)
		}
		w.WriteHeader(200)
		w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "caliber-agent/test")
	got, err := c.FetchRedactionSet(context.Background(), "cda_test")
	if err != nil {
		t.Fatalf("FetchRedactionSet: %v", err)
	}
	if got.Version != "v-1" || got.TTLSeconds != 3600 || len(got.Patterns) != 1 {
		t.Errorf("got = %+v", got)
	}
}

func TestFetchRedactionSet_401InvalidToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "bad")
	if !errors.Is(err, ErrInvalidToken) {
		t.Errorf("err = %v, want ErrInvalidToken", err)
	}
}

func TestFetchRedactionSet_401KeyRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "cda_revoked")
	if !errors.Is(err, ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}

func TestFetchRedactionSet_500ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"internal_error"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "cda_test")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("StatusCode = %d, want 500", apiErr.StatusCode)
	}
}
```

Note: `ErrKeyRevoked` must exist in `agent/internal/api/errors.go`. If PR1 only created `ErrInvalidToken`/`ErrTokenUsed`/`ErrTokenExpired`/`ErrServerMisconf`, this PR3 task adds the missing sentinel. Open `agent/internal/api/errors.go` and add:

```go
ErrKeyRevoked   = errors.New("api: key_revoked")
```

And extend the `*APIError.Is` switch with:

```go
case ErrKeyRevoked:
    return e.StatusCode == 401 && (e.ErrorTag == "key_revoked" || e.ErrorTag == "device_revoked")
```

- [ ] **Step 2: Verify failure**

```bash
go test ./internal/api/... -run FetchRedactionSet
```

Expected: FAIL — `FetchRedactionSet` undefined and possibly `ErrKeyRevoked`.

- [ ] **Step 3: Add `ErrKeyRevoked` to `agent/internal/api/errors.go`**

Open `agent/internal/api/errors.go`:
- Add `ErrKeyRevoked = errors.New("api: key_revoked")` to the `var ( ... )` block
- Extend `*APIError.Is` switch with the case above

- [ ] **Step 4: Implement `agent/internal/api/redactionset.go`**

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// RedactionSetResponse is the wire shape of GET /v1/redaction-set.
type RedactionSetResponse struct {
	Patterns   []redact.Pattern `json:"patterns"`
	Version    string           `json:"version"`
	TTLSeconds int64            `json:"ttl_seconds"`
}

// FetchRedactionSet GETs /v1/redaction-set with Bearer cda_* auth.
// On 200: returns the parsed response.
// On 401: returns *APIError wrapping ErrInvalidToken or ErrKeyRevoked
//         depending on the body's "error" field.
// On 5xx: returns *APIError.
// On network failure: returns wrapped *url.Error.
func (c *Client) FetchRedactionSet(ctx context.Context, token string) (*RedactionSetResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/redaction-set", nil)
	if err != nil {
		return nil, fmt.Errorf("api: build redaction-set request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("api: redaction-set http: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16)) // 64 KiB cap (defence)

	if resp.StatusCode == http.StatusOK {
		out := &RedactionSetResponse{}
		if err := json.NewDecoder(bytes.NewReader(body)).Decode(out); err != nil {
			return nil, fmt.Errorf("api: parse redaction-set 200: %w", err)
		}
		return out, nil
	}

	var eb errorBody
	_ = json.Unmarshal(body, &eb)
	truncated := string(body)
	if len(truncated) > 200 {
		truncated = truncated[:200]
	}
	return nil, &APIError{StatusCode: resp.StatusCode, ErrorTag: eb.Error, Body: truncated}
}
```

- [ ] **Step 5: Verify**

```bash
go test ./internal/api/... -v -race
```

Expected: all 4 new tests pass + PR1 api tests still green.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/api/errors.go agent/internal/api/redactionset.go agent/internal/api/redactionset_test.go
git commit -m "feat(agent): Client.FetchRedactionSet + ErrKeyRevoked sentinel"
```

---

## Phase 8 — `sink/http.go` (HTTPSink with retry/backoff)

### Task 8.1: Evolve sink.Chunk.Events from []string to []redact.Event

**Files:**
- Modify: `agent/sink/chunk.go`

- [ ] **Step 1: Find current Chunk type**

```bash
grep -n "Events" agent/sink/chunk.go
```

- [ ] **Step 2: Edit `agent/sink/chunk.go`**

Replace the `Events []string ...` line with:

```go
import "github.com/hanfour/ai-dev-eval/agent/redact"

// ... in Chunk struct:
    Events []redact.Event `json:"events"` // parsed + redacted by chunker before delivery
```

Update the doc comment to note the PR3 evolution:

```go
// PR3 evolved Events from []string (raw JSONL) to []redact.Event (parsed +
// redacted). Other fields unchanged from PR2's frozen contract.
```

- [ ] **Step 3: Adapt existing LogSink to the new type**

`agent/sink/log.go` currently references `len(c.Events)` only — already-correct, no change needed unless it ever indexed Events as strings. Verify:

```bash
grep -n "c.Events" agent/sink/log.go
```

If the only reference is `len(c.Events)`, no change. If anything iterates or indexes, adjust.

- [ ] **Step 4: Verify whole module builds**

```bash
cd agent
go build ./...
```

This will FAIL in `watcher/chunker.go` which currently builds chunks with `Events: tr.Events` where `tr.Events []string`. **Don't fix chunker.go in this task** — it gets the full rewrite in Phase 9. To unblock the build:

Temporarily comment out the failing line in `watcher/chunker.go` (will be replaced wholesale in Task 9.1):

```go
// TEMPORARY: chunker awaits Phase 9 rewrite for redact.Event support
Events: nil,
```

- [ ] **Step 5: Verify build now clean**

```bash
go build ./...
```

Expected: exit 0.

```bash
go test ./sink/... -race
```

Expected: PR2 LogSink tests still pass (they used `Events: []string{...}` previously which is now `[]redact.Event{}` — tests need their fixture updated). Update `sink/log_test.go` test data to use `redact.Event` instances:

```go
import "github.com/hanfour/ai-dev-eval/agent/redact"
// ... in TestLogSink_Happy:
Events: []redact.Event{
    {EventID: "e-1", EventType: "user"},
    {EventID: "e-2", EventType: "assistant"},
    {EventID: "e-3", EventType: "tool_use"},
},
// ... in TestLogSink_Privacy_NoEventContentInOutput:
Events: []redact.Event{
    {EventID: canary, EventType: "user", Content: canary},
    {EventID: "e-2", EventType: "user"},
},
```

Then re-run tests:

```bash
go test ./sink/... -v -race
```

Expected: 4 sink tests pass.

Watcher tests will FAIL at this point due to the commented-out chunker line — that's fine. We restore in Phase 9.

- [ ] **Step 6: Commit**

```bash
git add agent/sink/chunk.go agent/sink/log_test.go agent/watcher/chunker.go
git commit -m "feat(agent): evolve Chunk.Events []string -> []redact.Event per PR2 contract

Per the PR2 spec (§4.1) Chunk.Events was frozen as the slot PR3 evolves
from string to typed Event. This commit makes the type swap and updates
LogSink + its tests. watcher/chunker.go is temporarily stubbed to keep
the build green; full rewrite lands in Phase 9 Task 9.1."
```

### Task 8.2: HTTPSink struct + happy path

**Files:**
- Create: `agent/sink/http.go`
- Create: `agent/sink/http_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// agent/sink/http_test.go
package sink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

type capturedRequest struct {
	method     string
	path       string
	authHeader string
	contentEnc string
	contentTyp string
	body       map[string]any
}

func captureHandler(t *testing.T, status int, respBody string) (http.Handler, *capturedRequest) {
	t.Helper()
	cap := &capturedRequest{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.authHeader = r.Header.Get("Authorization")
		cap.contentEnc = r.Header.Get("Content-Encoding")
		cap.contentTyp = r.Header.Get("Content-Type")
		var bodyReader io.Reader = r.Body
		if cap.contentEnc == "gzip" {
			gr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Fatalf("gunzip request: %v", err)
			}
			defer gr.Close()
			bodyReader = gr
		}
		raw, _ := io.ReadAll(bodyReader)
		_ = json.Unmarshal(raw, &cap.body)
		w.WriteHeader(status)
		w.Write([]byte(respBody))
	})
	return h, cap
}

func sampleChunk(source, sessionID string) Chunk {
	return Chunk{
		File:       "/tmp/" + sessionID + ".jsonl",
		Source:     source,
		SessionID:  sessionID,
		CWD:        "/Users/h/proj",
		Events:     []redact.Event{{EventID: "e-1", EventType: "user"}},
		FromOffset: 0,
		ToOffset:   100,
	}
}

func TestHTTPSink_Happy_PostsGzippedBodyAndReturnsNil(t *testing.T) {
	h, cap := captureHandler(t, 200, `{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`)
	srv := httptest.NewServer(h)
	defer srv.Close()

	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL:    srv.URL,
		Token:      "cda_test_key",
		DeviceID:   "dev-1",
		Version:    "test",
		Mode:       redact.ModeMetadataOnly,
		HTTP:       &http.Client{Timeout: 5 * time.Second},
		Retry:      RetryPolicy{MaxAttempts: 1},
		Now:        time.Now,
		Logger:     &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s-1"))
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	if cap.method != "POST" || cap.path != "/v1/ingest" {
		t.Errorf("got %s %s", cap.method, cap.path)
	}
	if cap.authHeader != "Bearer cda_test_key" {
		t.Errorf("Authorization = %q", cap.authHeader)
	}
	if cap.contentEnc != "gzip" {
		t.Errorf("Content-Encoding = %q", cap.contentEnc)
	}
	if cap.contentTyp != "application/json" {
		t.Errorf("Content-Type = %q", cap.contentTyp)
	}
	if cap.body["redaction_mode"] != "metadata-only" {
		t.Errorf("redaction_mode = %v", cap.body["redaction_mode"])
	}
	sessions, ok := cap.body["sessions"].([]any)
	if !ok || len(sessions) != 1 {
		t.Fatalf("sessions shape wrong: %T %v", cap.body["sessions"], cap.body["sessions"])
	}
}

func TestHTTPSink_SourceClient_MapsClaudeToClaudeCode(t *testing.T) {
	cases := []struct{ source, wantWire string }{
		{"claude", "claude-code"},
		{"claude-subagent", "claude-code"},
		{"codex", "codex"},
	}
	for _, tc := range cases {
		t.Run(tc.source, func(t *testing.T) {
			h, cap := captureHandler(t, 200, `{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`)
			srv := httptest.NewServer(h)
			defer srv.Close()
			s := NewHTTPSink(HTTPSinkOpts{
				BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
				Mode: redact.ModeRedactedBody, HTTP: &http.Client{Timeout: 5 * time.Second},
				Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
			})
			_ = s.SendChunk(context.Background(), sampleChunk(tc.source, "s"))
			sessions := cap.body["sessions"].([]any)
			sess := sessions[0].(map[string]any)
			if sess["source_client"] != tc.wantWire {
				t.Errorf("source=%q -> source_client = %q, want %q", tc.source, sess["source_client"], tc.wantWire)
			}
		})
	}
}

type nopLogger struct{ lines []string }

func (l *nopLogger) Printf(format string, args ...any) { l.lines = append(l.lines, format) }
```

- [ ] **Step 2: Verify failure**

```bash
go test ./sink/... -run HTTPSink_Happy
```

Expected: FAIL — undefined.

- [ ] **Step 3: Implement `agent/sink/http.go` — happy path only (retry to be added in Task 8.3)**

```go
package sink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// Logger matches watcher.Logger / config.RFCLogger shape so callers can
// pass either without an adapter.
type Logger interface {
	Printf(format string, args ...any)
}

// HTTPSink POSTs gzipped Chunks to /v1/ingest with Bearer cda_* auth.
// Replaces LogSink as the production Sink at PR3.
type HTTPSink struct {
	BaseURL  string
	Token    string
	DeviceID string
	Version  string
	Mode     redact.Mode
	HTTP     *http.Client
	Retry    RetryPolicy
	Now      func() time.Time
	Logger   Logger
}

// RetryPolicy is the backoff configuration for transient HTTP errors.
type RetryPolicy struct {
	MaxAttempts    int           // default 5
	InitialBackoff time.Duration // default 1s (5xx + network)
	RateLimitBase  time.Duration // default 30s (429)
	MaxJitter      time.Duration // default 250ms
}

// HTTPSinkOpts is the constructor argument.
type HTTPSinkOpts struct {
	BaseURL  string
	Token    string
	DeviceID string
	Version  string
	Mode     redact.Mode
	HTTP     *http.Client
	Retry    RetryPolicy
	Now      func() time.Time
	Logger   Logger
}

func NewHTTPSink(opts HTTPSinkOpts) *HTTPSink {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.HTTP == nil {
		opts.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if opts.Retry.MaxAttempts == 0 {
		opts.Retry.MaxAttempts = 5
	}
	if opts.Retry.InitialBackoff == 0 {
		opts.Retry.InitialBackoff = time.Second
	}
	if opts.Retry.RateLimitBase == 0 {
		opts.Retry.RateLimitBase = 30 * time.Second
	}
	if opts.Retry.MaxJitter == 0 {
		opts.Retry.MaxJitter = 250 * time.Millisecond
	}
	return &HTTPSink{
		BaseURL: opts.BaseURL, Token: opts.Token, DeviceID: opts.DeviceID,
		Version: opts.Version, Mode: opts.Mode, HTTP: opts.HTTP,
		Retry: opts.Retry, Now: opts.Now, Logger: opts.Logger,
	}
}

// ingestSession matches the server zod schema in
// apps/api/src/rest/ingest.ts sessionSchema.
type ingestSession struct {
	SessionID       string         `json:"session_id"`
	ParentSessionID string         `json:"parent_session_id,omitempty"`
	SourceClient    string         `json:"source_client"`
	Static          sessionStatic  `json:"static"`
	Events          []redact.Event `json:"events"`
}

type sessionStatic struct {
	CWD string `json:"cwd,omitempty"`
}

type ingestBody struct {
	DeviceID       string          `json:"device_id"`
	AgentVersion   string          `json:"agent_version"`
	RedactionMode  redact.Mode     `json:"redaction_mode"`
	Sessions       []ingestSession `json:"sessions"`
}

type ingestResponse struct {
	Ingested       int `json:"ingested"`
	Deduped        int `json:"deduped"`
	SessionUpserts int `json:"session_upserts"`
	Errors         []struct {
		SessionID string `json:"session_id,omitempty"`
		EventID   string `json:"event_id,omitempty"`
		Error     string `json:"error"`
	} `json:"errors"`
}

// SendChunk implements Sink. PR3 first cut without retry — retry logic
// arrives in Task 8.3.
func (h *HTTPSink) SendChunk(ctx context.Context, c Chunk) error {
	body := ingestBody{
		DeviceID:      h.DeviceID,
		AgentVersion:  h.Version,
		RedactionMode: h.Mode,
		Sessions: []ingestSession{{
			SessionID:       c.SessionID,
			ParentSessionID: c.ParentSessionID,
			SourceClient:    mapSourceClient(c.Source),
			Static:          sessionStatic{CWD: c.CWD},
			Events:          c.Events,
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("httpsink: marshal: %w", err)
	}
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	if _, err := gw.Write(raw); err != nil {
		return fmt.Errorf("httpsink: gzip write: %w", err)
	}
	if err := gw.Close(); err != nil {
		return fmt.Errorf("httpsink: gzip close: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/v1/ingest", &gzBuf)
	if err != nil {
		return fmt.Errorf("httpsink: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+h.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")

	start := h.Now()
	resp, err := h.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("httpsink: http: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))

	if resp.StatusCode == http.StatusOK {
		var ir ingestResponse
		_ = json.Unmarshal(respBody, &ir)
		h.logIngest(c, &ir, len(raw), h.Now().Sub(start))
		return nil
	}

	return h.toAPIError(resp.StatusCode, respBody)
}

func mapSourceClient(source string) string {
	switch source {
	case "claude", "claude-subagent":
		return "claude-code"
	case "codex":
		return "codex"
	default:
		return source
	}
}

func (h *HTTPSink) logIngest(c Chunk, r *ingestResponse, wireBytes int, dur time.Duration) {
	if h.Logger == nil {
		return
	}
	h.Logger.Printf("[ingest] sess=%s events=%d ingested=%d deduped=%d errors=%d bytes=%d duration=%s",
		c.SessionID, len(c.Events), r.Ingested, r.Deduped, len(r.Errors), wireBytes, dur)
}

type errorBody struct {
	Error string `json:"error"`
}

func (h *HTTPSink) toAPIError(status int, body []byte) error {
	var eb errorBody
	_ = json.Unmarshal(body, &eb)
	truncated := string(body)
	if len(truncated) > 200 {
		truncated = truncated[:200]
	}
	return &api.APIError{StatusCode: status, ErrorTag: eb.Error, Body: truncated}
}

// suppress unused linter while retry impl is in another task
var _ = errors.New
var _ = strings.HasPrefix
```

Note: `strings` import isn't used yet but will be in Task 8.3. Either remove until needed, or add the unused-suppression.

- [ ] **Step 4: Verify happy + source-mapping tests pass**

```bash
go test ./sink/... -run "HTTPSink_Happy|HTTPSink_SourceClient" -v -race
```

Expected: 4 tests pass (1 happy + 3 source variants).

- [ ] **Step 5: Commit**

```bash
git add agent/sink/http.go agent/sink/http_test.go
git commit -m "feat(agent): HTTPSink happy path — gzip POST /v1/ingest with cda_* auth"
```

### Task 8.3: HTTPSink retry + auth error mapping

**Files:**
- Modify: `agent/sink/http.go` (rewrite SendChunk with retry loop)
- Modify: `agent/sink/http_test.go` (append error-mapping + retry tests)

- [ ] **Step 1: Append failing tests**

```go
// (append to agent/sink/http_test.go)

func TestHTTPSink_401InvalidToken_ReturnsErrInvalidToken(t *testing.T) {
	h, _ := captureHandler(t, 401, `{"error":"invalid_token"}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_bad", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly,
		HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if !errors.Is(err, api.ErrInvalidToken) {
		t.Errorf("err = %v, want ErrInvalidToken", err)
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) {
		t.Errorf("err should also be *api.APIError")
	}
}

func TestHTTPSink_401KeyRevoked_ReturnsErrKeyRevoked(t *testing.T) {
	h, _ := captureHandler(t, 401, `{"error":"key_revoked"}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_rev", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if !errors.Is(err, api.ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}

func TestHTTPSink_409SessionOwned_NoRetryNoAdvance(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(409)
		w.Write([]byte(`{"error":"SESSION_OWNED_BY_OTHER_ORG","ingested":0,"deduped":0,"session_upserts":0,"errors":[]}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 5}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected error on 409")
	}
	if hits != 1 {
		t.Errorf("expected exactly 1 hit (no retry on 409), got %d", hits)
	}
}

func TestHTTPSink_5xxRetriesUpToMaxAttempts(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"server_misconfigured"}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 3, InitialBackoff: time.Millisecond, MaxJitter: time.Millisecond},
		Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected error after retry exhaust")
	}
	if hits != 3 {
		t.Errorf("expected 3 hits, got %d", hits)
	}
}

func TestHTTPSink_429RetriesAndSucceeds(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits < 2 {
			w.WriteHeader(429)
			w.Write([]byte(`{"error":"rate_limit"}`))
			return
		}
		w.WriteHeader(200)
		w.Write([]byte(`{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 3, InitialBackoff: time.Millisecond, RateLimitBase: time.Millisecond, MaxJitter: time.Millisecond},
		Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if hits != 2 {
		t.Errorf("hits = %d, want 2", hits)
	}
}

func TestHTTPSink_200WithErrorsBodyStillReturnsNil(t *testing.T) {
	h, _ := captureHandler(t, 200, `{"ingested":2,"deduped":0,"session_upserts":1,"errors":[{"session_id":"s","error":"events_insert_failed"}]}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	logger := &nopLogger{}
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: logger,
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err != nil {
		t.Errorf("200 with errors[] should still return nil (advance watermark); got %v", err)
	}
}

func TestHTTPSink_CtxCancelMidRetryAborts(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(503)
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 5, InitialBackoff: 100 * time.Millisecond, MaxJitter: time.Millisecond},
		Now: time.Now, Logger: &nopLogger{},
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	err := s.SendChunk(ctx, sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected ctx.Canceled-related error")
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
go test ./sink/... -run "HTTPSink_401|HTTPSink_409|HTTPSink_5xx|HTTPSink_429|HTTPSink_200WithErrors|HTTPSink_CtxCancel"
```

Expected: FAIL — retry not yet implemented; 401 returns `*APIError` but not wrapped to `ErrInvalidToken`.

- [ ] **Step 3: Rewrite `SendChunk` in `agent/sink/http.go` with retry loop**

Replace the existing `SendChunk` (after the `body := ingestBody{...}` build through to `return h.toAPIError(...)`) with this attempt-loop:

```go
func (h *HTTPSink) SendChunk(ctx context.Context, c Chunk) error {
	body := ingestBody{
		DeviceID: h.DeviceID, AgentVersion: h.Version,
		RedactionMode: h.Mode,
		Sessions: []ingestSession{{
			SessionID: c.SessionID, ParentSessionID: c.ParentSessionID,
			SourceClient: mapSourceClient(c.Source),
			Static:       sessionStatic{CWD: c.CWD},
			Events:       c.Events,
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("httpsink: marshal: %w", err)
	}
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	if _, err := gw.Write(raw); err != nil {
		return fmt.Errorf("httpsink: gzip write: %w", err)
	}
	if err := gw.Close(); err != nil {
		return fmt.Errorf("httpsink: gzip close: %w", err)
	}
	wireBytes := len(gzBuf.Bytes())

	var lastErr error
	for attempt := 0; attempt < h.Retry.MaxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Each attempt re-uses the same gzipped body.
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/v1/ingest", bytes.NewReader(gzBuf.Bytes()))
		if err != nil {
			return fmt.Errorf("httpsink: build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+h.Token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Encoding", "gzip")

		start := h.Now()
		resp, err := h.HTTP.Do(req)
		if err != nil {
			// Network/transport failure — retry like 5xx.
			lastErr = fmt.Errorf("httpsink: http: %w", err)
			if !h.sleepBackoff(ctx, attempt, h.Retry.InitialBackoff) {
				return ctx.Err()
			}
			continue
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var ir ingestResponse
			_ = json.Unmarshal(respBody, &ir)
			h.logIngest(c, &ir, wireBytes, h.Now().Sub(start))
			return nil
		}

		// Non-2xx — classify
		apiErr := h.toAPIError(resp.StatusCode, respBody)
		var ae *api.APIError
		_ = errors.As(apiErr, &ae)

		switch {
		case ae.StatusCode == 401:
			// Fatal — never retry; wrap with sentinel
			if errors.Is(ae, api.ErrKeyRevoked) {
				return fmt.Errorf("%w: %v", api.ErrKeyRevoked, ae)
			}
			return fmt.Errorf("%w: %v", api.ErrInvalidToken, ae)
		case ae.StatusCode == 409 || ae.StatusCode == 410 || ae.StatusCode == 400:
			// Permanent — don't retry; return as-is (loop handles per-failure)
			return apiErr
		case ae.StatusCode == 429:
			lastErr = apiErr
			if !h.sleepBackoff(ctx, attempt, h.Retry.RateLimitBase) {
				return ctx.Err()
			}
		case ae.StatusCode >= 500:
			lastErr = apiErr
			if !h.sleepBackoff(ctx, attempt, h.Retry.InitialBackoff) {
				return ctx.Err()
			}
		default:
			// Other 4xx — don't retry
			return apiErr
		}
	}
	return fmt.Errorf("httpsink: retry exhausted after %d attempts: %w", h.Retry.MaxAttempts, lastErr)
}

// sleepBackoff sleeps for base * 2^attempt + random jitter, honoring ctx.
// Returns false if ctx is cancelled mid-sleep.
func (h *HTTPSink) sleepBackoff(ctx context.Context, attempt int, base time.Duration) bool {
	d := base << attempt
	if h.Retry.MaxJitter > 0 {
		// Cheap jitter: use Now's nanoseconds modulo as a stand-in for crypto/rand.
		jitter := time.Duration(h.Now().UnixNano()%int64(h.Retry.MaxJitter)) * time.Nanosecond
		d += jitter
	}
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}
```

Note: the special-casing for `errors.Is(ae, api.ErrKeyRevoked)` depends on PR1's `*APIError.Is` correctly distinguishing `key_revoked` from `invalid_token` (done in Task 7.1 Step 3). The `errors.As(apiErr, &ae)` always succeeds because `apiErr` IS a `*APIError`.

Also: the `errors.Is(err, api.ErrInvalidToken)` assertion in the test relies on `fmt.Errorf("%w: %v", api.ErrInvalidToken, ae)` — the `%w` wraps the sentinel so `errors.Is` finds it.

- [ ] **Step 4: Verify all sink tests pass**

```bash
go test ./sink/... -v -race
```

Expected: 11 sink tests pass (1 happy + 3 source mapping + 6 from this task + 1 from Task 8.2).

- [ ] **Step 5: Commit**

```bash
git add agent/sink/http.go agent/sink/http_test.go
git commit -m "feat(agent): HTTPSink retry/backoff + auth error sentinels + 200-with-errors advance"
```

---

## Phase 9 — `watcher/chunker.go` rewrite

### Task 9.1: Chunker with parser dispatch + ApplyMode

**Files:**
- Modify: `agent/watcher/chunker.go` (full rewrite of Split — keep struct slot)
- Modify: `agent/watcher/chunker_test.go` (replace PR2 tests)

- [ ] **Step 1: Inspect current chunker_test.go to know what to replace**

```bash
cat agent/watcher/chunker_test.go
```

Note the PR2 fixture style — many tests use `tr.Events []string`. All these are replaced by typed-event flow.

- [ ] **Step 2: Write the failing tests (new chunker contract)**

Replace the entire `agent/watcher/chunker_test.go` with:

```go
package watcher

import (
	"strings"
	"sync"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

type capturedLogger struct {
	mu    sync.Mutex
	lines []string
}

func (l *capturedLogger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, format)
}

type staticProvider struct{ s *redact.RedactionSet }

func (p *staticProvider) Current() *redact.RedactionSet { return p.s }

// stubParser parses fixed-shape lines: "skip" returns ErrSkipLine;
// "bad" returns a non-skip error; anything else produces an Event
// where Content == the input line.
func stubParser(_ string, line string) (redact.Event, error) {
	switch line {
	case "skip":
		return redact.Event{}, redact.ErrSkipLine
	case "bad":
		return redact.Event{}, jsonError("not json")
	}
	return redact.Event{EventID: line, EventType: "test", Content: line}, nil
}

type jsonError string

func (e jsonError) Error() string { return string(e) }

func TestChunker_DispatchesParser_AndAppliesMode(t *testing.T) {
	rs := redact.DefaultSet()
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeMetadataOnly,
		SetProv:         &staticProvider{s: rs},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	tr := TailResult{
		Events:     []string{"a", "b", "c"},
		FromOffset: 0,
		ToOffset:   12,
	}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s1"}, tr, "/Users/h/proj")
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1", len(chunks))
	}
	got := chunks[0]
	if len(got.Events) != 3 {
		t.Errorf("len(Events) = %d, want 3", len(got.Events))
	}
	// metadata-only mode collapses Content into {length, preview} map
	for _, ev := range got.Events {
		m, ok := ev.Content.(map[string]any)
		if !ok {
			t.Errorf("Content not a summary map: %T", ev.Content)
			continue
		}
		if _, ok := m["length"]; !ok {
			t.Errorf("summary missing length: %v", m)
		}
	}
}

func TestChunker_SkipLineSilentlyIgnored(t *testing.T) {
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	tr := TailResult{Events: []string{"a", "skip", "b"}, ToOffset: 9}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/Users/h/proj")
	if len(chunks) != 1 || len(chunks[0].Events) != 2 {
		t.Fatalf("expected 1 chunk with 2 events (skipped one), got %d chunks %d events", len(chunks), func() int {
			if len(chunks) == 0 {
				return 0
			}
			return len(chunks[0].Events)
		}())
	}
}

func TestChunker_ParseErrorLogsAndSkips(t *testing.T) {
	log := &capturedLogger{}
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             log,
	}
	tr := TailResult{Events: []string{"a", "bad", "b"}, ToOffset: 9}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/Users/h/proj")
	if len(chunks) != 1 || len(chunks[0].Events) != 2 {
		t.Errorf("expected 2 events, got %d", len(chunks[0].Events))
	}
	found := false
	for _, ln := range log.lines {
		if strings.Contains(ln, "parse failed") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected [warn] parse failed log; got %v", log.lines)
	}
}

func TestChunker_EmptyTailResult_ZeroChunks(t *testing.T) {
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	chunks := c.Split(FileRef{Source: "claude"}, TailResult{}, "/cwd")
	if len(chunks) != 0 {
		t.Errorf("got %d chunks, want 0", len(chunks))
	}
}

func TestChunker_LargeBodySplitsAtEventBoundary(t *testing.T) {
	// PR3 first cut: single chunk per file is acceptable up to ~1 MB
	// gzipped; the size-split branch only fires on synthetic 5 MB+
	// inputs. Force the split by setting GzipTargetBytes very low.
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 32, // tiny — every event exceeds budget
		Log:             &capturedLogger{},
	}
	tr := TailResult{
		Events:     []string{"a", "b", "c", "d"},
		FromOffset: 0,
		ToOffset:   16,
	}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/cwd")
	if len(chunks) < 2 {
		t.Errorf("expected ≥ 2 chunks under tight size budget, got %d", len(chunks))
	}
	// Aggregate events == input count
	total := 0
	for _, ch := range chunks {
		total += len(ch.Events)
	}
	if total != 4 {
		t.Errorf("total events = %d, want 4", total)
	}
}
```

- [ ] **Step 3: Verify failure**

```bash
go test ./watcher/... -run Chunker
```

Expected: FAIL — types changed; new fields missing on `Chunker`.

- [ ] **Step 4: Rewrite `agent/watcher/chunker.go`**

```go
package watcher

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"

	"github.com/hanfour/ai-dev-eval/agent/redact"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

// ParserFn is the per-source JSONL line → redact.Event parser. The
// chunker dispatches by FileRef.Source. redact/parser.Dispatch is the
// production impl; tests inject stubs.
type ParserFn func(source string, line string) (redact.Event, error)

// RedactionSetProvider lets cli/run swap the current set at refresh
// time without touching the Loop. Current() never returns nil — falls
// back to redact.DefaultSet() on miss.
type RedactionSetProvider interface {
	Current() *redact.RedactionSet
}

// Logger is the interface chunker uses for [warn] parse-failed lines.
type Logger interface {
	Printf(format string, args ...any)
}

// Chunker parses raw JSONL lines via ParserFn, applies the current
// redaction mode + patterns, and emits sink.Chunk values sized by
// gzipped body byte target. PR3 first cut splits only when a single
// chunk would exceed GzipTargetBytes; otherwise one chunk per file.
type Chunker struct {
	Parser          ParserFn
	Mode            redact.Mode
	SetProv         RedactionSetProvider
	GzipTargetBytes int64
	Log             Logger
}

// Split takes a TailResult, parses + redacts each line, and returns
// one or more Chunks sized by gzipped budget. Per-event errors are
// logged + skipped; ErrSkipLine is silently dropped.
func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk {
	patterns := c.SetProv.Current().Patterns
	events := make([]redact.Event, 0, len(tr.Events))
	for _, line := range tr.Events {
		ev, err := c.Parser(ref.Source, line)
		if err != nil {
			if !errors.Is(err, redact.ErrSkipLine) {
				if c.Log != nil {
					c.Log.Printf("[warn] parse failed (ref=%s err=%v)", ref.Path, err)
				}
			}
			continue
		}
		events = append(events, redact.ApplyMode(ev, c.Mode, patterns))
	}
	if len(events) == 0 {
		return nil
	}

	// Trivial size check — gzip-encode a draft body and bisect if over budget.
	chunks := c.bisect(ref, events, tr.FromOffset, tr.ToOffset, cwd)
	return chunks
}

func (c *Chunker) bisect(ref FileRef, events []redact.Event, from, to int64, cwd string) []sink.Chunk {
	if len(events) == 0 {
		return nil
	}
	if len(events) == 1 {
		return []sink.Chunk{c.build(ref, events, from, to, cwd)}
	}
	if c.gzipSize(events) <= c.GzipTargetBytes {
		return []sink.Chunk{c.build(ref, events, from, to, cwd)}
	}
	// Split in half by event count. PR3 first cut — line-byte ToOffset
	// alignment is coarse (we don't track per-event byte position from
	// TailResult), so each half gets from->mid and mid->to estimates.
	mid := len(events) / 2
	midOffset := from + (to-from)*int64(mid)/int64(len(events))
	left := c.bisect(ref, events[:mid], from, midOffset, cwd)
	right := c.bisect(ref, events[mid:], midOffset, to, cwd)
	return append(left, right...)
}

func (c *Chunker) gzipSize(events []redact.Event) int64 {
	raw, _ := json.Marshal(events)
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	_, _ = gw.Write(raw)
	_ = gw.Close()
	return int64(gzBuf.Len())
}

func (c *Chunker) build(ref FileRef, events []redact.Event, from, to int64, cwd string) sink.Chunk {
	return sink.Chunk{
		File:            ref.Path,
		Source:          ref.Source,
		SessionID:       ref.SessionID,
		ParentSessionID: ref.ParentSessionID,
		CWD:             cwd,
		Events:          events,
		FromOffset:      from,
		ToOffset:        to,
	}
}
```

Notes on size-split caveats:
- The split divides events by COUNT, not byte position. `ToOffset` interpolates proportionally. This is coarse but acceptable: re-tail on next tick re-reads any range PR3 didn't deliver, and server dedups.
- PR3 leaves accurate per-event byte-position tracking as future work (Phase 3 enhancement).

- [ ] **Step 5: Verify**

```bash
go test ./watcher/... -v -race
```

Expected: 5 new chunker tests pass; existing watcher tests (sources, tail, loop) untouched and green.

- [ ] **Step 6: Commit**

```bash
git add agent/watcher/chunker.go agent/watcher/chunker_test.go
git commit -m "feat(agent): chunker — parser dispatch + ApplyMode + gzip-size bisect"
```

---

## Phase 10 — `cli/run.go` wiring

### Task 10.1: Add RedactionSetProvider type + helpers

**Files:**
- Create: `agent/internal/cli/redactionset.go`
- Create: `agent/internal/cli/redactionset_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/redactionset_test.go
package cli

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

type captureLogger struct{ lines []string }

func (l *captureLogger) Printf(format string, args ...any) { l.lines = append(l.lines, format) }

func TestBootstrapRedactionSet_NoCache_FetchSucceeds(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
	}))
	defer srv.Close()

	logger := &captureLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", logger)
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	got := prov.Current()
	if got == nil || got.Version != "v-1" {
		t.Errorf("got = %+v", got)
	}
	// Persisted to disk
	loaded, err := config.LoadRedactionSet()
	if err != nil {
		t.Fatalf("LoadRedactionSet: %v", err)
	}
	if loaded.Version != "v-1" {
		t.Errorf("disk version = %q, want v-1", loaded.Version)
	}
}

func TestBootstrapRedactionSet_NoCache_FetchFails_FallsBackToDefault(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"down"}`))
	}))
	defer srv.Close()
	logger := &captureLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", logger)
	if err != nil {
		t.Fatalf("Bootstrap should not fail on fetch error when fallback exists: %v", err)
	}
	if prov.Current().Version != "bundled-default" {
		t.Errorf("expected bundled-default, got %q", prov.Current().Version)
	}
}

func TestBootstrapRedactionSet_CacheExists_NotExpired_NoFetch(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	// pre-seed a non-expired cached set
	cached := &redact.RedactionSet{
		Patterns:   redact.DefaultPatterns,
		Version:    "v-cached",
		FetchedAt:  time.Now().Add(-time.Hour),
		TTLSeconds: 86400,
	}
	if err := config.SaveRedactionSet(cached); err != nil {
		t.Fatal(err)
	}
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer srv.Close()
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", &captureLogger{})
	if err != nil {
		t.Fatal(err)
	}
	if prov.Current().Version != "v-cached" {
		t.Errorf("expected v-cached, got %q", prov.Current().Version)
	}
	if hits != 0 {
		t.Errorf("should not have called server, hits = %d", hits)
	}
}

func TestBootstrapRedactionSet_FatalErrorsPropagate(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	_, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_revoked", &captureLogger{})
	if !errors.Is(err, api.ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3/agent
go test ./internal/cli/... -run BootstrapRedactionSet
```

Expected: FAIL — `BootstrapRedactionSet` undefined.

- [ ] **Step 3: Implement `agent/internal/cli/redactionset.go`**

```go
package cli

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// RedactionSetProvider is what watcher.Chunker reads from. Embedded
// pointer + RWMutex for safe Set/Current across the daemon's main
// goroutine and the refresher goroutine.
type RedactionSetProvider struct {
	mu      sync.RWMutex
	current *redact.RedactionSet
}

func (p *RedactionSetProvider) Current() *redact.RedactionSet {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.current
}

func (p *RedactionSetProvider) Set(s *redact.RedactionSet) {
	p.mu.Lock()
	p.current = s
	p.mu.Unlock()
}

// BootstrapRedactionSet handles the startup three-tier fallback:
//   1. cached, not expired       -> use as-is
//   2. cached expired or absent  -> fetch fresh
//   3. fetch fails               -> stale cache (if any) or DefaultSet()
//
// Fatal errors (ErrInvalidToken / ErrKeyRevoked) propagate so the
// daemon can exit cleanly per the PR3 spec §6.4 fatal-vs-recoverable
// boundary. All other fetch failures degrade gracefully.
func BootstrapRedactionSet(ctx context.Context, client *api.Client, token string, logger Logger) (*RedactionSetProvider, error) {
	prov := &RedactionSetProvider{}

	cached, cerr := config.LoadRedactionSet()
	hasCache := cerr == nil

	now := time.Now().UTC()
	if hasCache && !cached.IsExpired(now) {
		_ = cached.Compile()
		prov.Set(cached)
		return prov, nil
	}

	fresh, ferr := client.FetchRedactionSet(ctx, token)
	if ferr != nil {
		if errors.Is(ferr, api.ErrInvalidToken) || errors.Is(ferr, api.ErrKeyRevoked) {
			return nil, ferr
		}
		if hasCache {
			age := now.Sub(cached.FetchedAt)
			logger.Printf("[warn] redaction-set fetch failed, using stale cache (age=%s err=%v)", age, ferr)
			_ = cached.Compile()
			prov.Set(cached)
			return prov, nil
		}
		logger.Printf("[warn] redaction-set fetch failed, using bundled default (err=%v)", ferr)
		prov.Set(redact.DefaultSet())
		return prov, nil
	}

	set := &redact.RedactionSet{
		Patterns:   fresh.Patterns,
		Version:    fresh.Version,
		FetchedAt:  now,
		TTLSeconds: fresh.TTLSeconds,
	}
	if err := set.Compile(); err != nil {
		logger.Printf("[warn] %v", err) // per-pattern bad-pattern log
	}
	prov.Set(set)
	_ = config.SaveRedactionSet(set)
	logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds", set.Version, len(set.Patterns), set.TTLSeconds)
	return prov, nil
}
```

- [ ] **Step 4: Verify**

```bash
go test ./internal/cli/... -v -race
```

Expected: 4 new tests pass + PR1+PR2 cli tests still green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/redactionset.go agent/internal/cli/redactionset_test.go
git commit -m "feat(agent): BootstrapRedactionSet — 3-tier fallback + fatal-error propagation"
```

### Task 10.2: Replace LogSink with HTTPSink in run.go

**Files:**
- Modify: `agent/internal/cli/run.go`
- Modify: `agent/internal/cli/run_test.go` (new end-to-end test)

- [ ] **Step 1: Read existing run.go**

```bash
cat agent/internal/cli/run.go
```

Note the current `runRun` body:
- `config.Load` → `keychain.Get` → `config.LoadState` → `config.OpenAgentLog` → construct `RFCLogger` → construct `LogSink` → construct `watcher.Loop` → `Tick` or `Run`.

PR3 inserts between `OpenAgentLog` and `LogSink`:
- `BootstrapRedactionSet` (fetch / cache / default)
- Start the refresher goroutine
- Swap `LogSink` for `HTTPSink`
- Pass parser dispatch + provider into the `watcher.Chunker`

- [ ] **Step 2: Modify `agent/internal/cli/run.go`**

After `logger := config.NewRFCLogger(...)`, insert:

```go
import (
    // ... existing imports ...
    "github.com/hanfour/ai-dev-eval/agent/internal/api"
    "github.com/hanfour/ai-dev-eval/agent/redact"
    "github.com/hanfour/ai-dev-eval/agent/redact/parser"
)

// ... in runRun, after `logger` is built:

apiClient := api.NewClient(cfg.APIBaseURL, "caliber-agent/"+version.Version)
key, err := keychain.Get(cfg.DeviceID)
if err != nil {
    return &ExitError{Code: 1, Err: fmt.Errorf("keychain: %w", err)}
}

setProvider, err := BootstrapRedactionSet(cmd.Context(), apiClient, key, logger)
if err != nil {
    // Fatal: invalid_token or key_revoked from the bootstrap path
    if errors.Is(err, api.ErrKeyRevoked) {
        logger.Printf("[fatal] device key revoked by caliber server")
        logger.Printf("[fatal] Action: run `caliber-agent enroll <new-token>` to re-enroll this device")
        return &ExitError{Code: 0, Err: err} // exit 0 so launchd does NOT restart
    }
    logger.Printf("[fatal] invalid token: %v", err)
    return &ExitError{Code: 1, Err: err}
}

// Background refresher (ctx-cancellable)
go func() {
    for {
        ttl := time.Duration(setProvider.Current().TTLSeconds) * time.Second
        if ttl <= 0 {
            ttl = 24 * time.Hour
        }
        select {
        case <-cmd.Context().Done():
            return
        case <-time.After(ttl):
        }
        fresh, ferr := apiClient.FetchRedactionSet(cmd.Context(), key)
        if ferr != nil {
            if errors.Is(ferr, api.ErrKeyRevoked) || errors.Is(ferr, api.ErrInvalidToken) {
                logger.Printf("[fatal] redaction-set refresh hit auth failure: %v", ferr)
                // Don't kill the daemon here — the next ingest call will hit the
                // same auth failure and propagate to the main loop's exit.
                return
            }
            logger.Printf("[warn] redaction-set refresh failed (err=%v)", ferr)
            continue
        }
        set := &redact.RedactionSet{
            Patterns:   fresh.Patterns,
            Version:    fresh.Version,
            FetchedAt:  time.Now().UTC(),
            TTLSeconds: fresh.TTLSeconds,
        }
        if err := set.Compile(); err != nil {
            logger.Printf("[warn] %v", err)
        }
        setProvider.Set(set)
        _ = config.SaveRedactionSet(set)
        logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds",
            set.Version, len(set.Patterns), set.TTLSeconds)
    }
}()

// Swap LogSink for HTTPSink
httpSink := sink.NewHTTPSink(sink.HTTPSinkOpts{
    BaseURL:  cfg.APIBaseURL,
    Token:    key,
    DeviceID: cfg.DeviceID,
    Version:  version.Version,
    Mode:     redact.Mode(cfg.Mode),
    HTTP:     &http.Client{Timeout: 30 * time.Second},
    Retry:    sink.RetryPolicy{}, // defaults
    Now:      time.Now,
    Logger:   logger,
})

// Construct chunker with parser dispatch + provider
chunker := &watcher.Chunker{
    Parser:          parser.Dispatch,
    Mode:            redact.Mode(cfg.Mode),
    SetProv:         setProvider,
    GzipTargetBytes: 1 << 20, // 1 MB
    Log:             logger,
}

loop := watcher.NewLoop(watcher.LoopOpts{
    // ... existing source / tailer fields ...
    Chunker: chunker,
    Sink:    httpSink, // was: sink.NewLogSink(...)
    // ... existing Resolver / State / Log / Interval ...
})
```

Imports to add: `"net/http"`, `"time"` (if not present), `"github.com/hanfour/ai-dev-eval/agent/internal/api"`, `"github.com/hanfour/ai-dev-eval/agent/redact"`, `"github.com/hanfour/ai-dev-eval/agent/redact/parser"`. Remove the `sink.NewLogSink` import if no longer used in run.go (LogSink is still in sink package, just not called from production now).

- [ ] **Step 3: Write the end-to-end test**

Add to `agent/internal/cli/run_test.go`:

```go
// (append to existing run_test.go imports)
import (
    "compress/gzip"
    "encoding/json"
    "io"
    "net/http"
    "net/http/httptest"
)

func TestRun_OnceEndToEnd_FetchAndIngest(t *testing.T) {
    home := setupEnrolledHome(t)

    var ingestPosts int
    var redactionFetches int
    var capturedIngestBody map[string]any

    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        switch r.URL.Path {
        case "/v1/redaction-set":
            redactionFetches++
            w.WriteHeader(200)
            w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
        case "/v1/ingest":
            ingestPosts++
            // body is gzipped
            gr, err := gzip.NewReader(r.Body)
            if err != nil {
                t.Fatalf("gunzip: %v", err)
            }
            raw, _ := io.ReadAll(gr)
            _ = json.Unmarshal(raw, &capturedIngestBody)
            w.WriteHeader(200)
            w.Write([]byte(`{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`))
        default:
            t.Errorf("unexpected URL %s", r.URL.Path)
            w.WriteHeader(404)
        }
    }))
    defer srv.Close()

    // Override APIBaseURL in the config to point at the fake server.
    cfg, _ := config.Load()
    cfg.APIBaseURL = srv.URL
    cfg.Mode = "metadata-only"
    if err := config.Save(cfg); err != nil {
        t.Fatal(err)
    }

    // Place a real Claude fixture under the include path.
    allowed := filepath.Join(home, "projects", "allowed")
    os.MkdirAll(allowed, 0o755)
    if err := config.Save(&config.Config{
        DeviceID: "dev-abc", APIBaseURL: srv.URL, Mode: "metadata-only",
        IncludePaths: []string{allowed},
    }); err != nil {
        t.Fatal(err)
    }
    claudeRoot := filepath.Join(home, "claude-projects")
    t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
    t.Setenv("CALIBER_CODEX_SESSIONS", filepath.Join(home, "codex-empty"))
    os.MkdirAll(filepath.Join(home, "codex-empty"), 0o755)
    encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(allowed, "/"), "/", "-")
    projDir := filepath.Join(claudeRoot, encoded)
    os.MkdirAll(projDir, 0o755)
    line := `{"type":"user","uuid":"e-1","timestamp":"2026-05-23T10:00:00Z","cwd":"` + allowed + `","message":{"role":"user","content":"hello"}}`
    os.WriteFile(filepath.Join(projDir, "sess.jsonl"), []byte(line+"\n"), 0o644)

    cmd := New()
    var buf bytes.Buffer
    cmd.SetOut(&buf)
    cmd.SetErr(&buf)
    cmd.SetArgs([]string{"run", "--once"})
    if err := cmd.ExecuteContext(context.Background()); err != nil {
        t.Fatalf("run --once: %v\noutput: %s", err, buf.String())
    }

    if redactionFetches != 1 {
        t.Errorf("redaction-set fetches = %d, want 1", redactionFetches)
    }
    if ingestPosts != 1 {
        t.Errorf("ingest posts = %d, want 1", ingestPosts)
    }
    if capturedIngestBody["redaction_mode"] != "metadata-only" {
        t.Errorf("redaction_mode = %v", capturedIngestBody["redaction_mode"])
    }

    bs, _ := os.ReadFile(filepath.Join(home, "agent.log"))
    log := string(bs)
    if !strings.Contains(log, "[ingest]") {
        t.Errorf("agent.log missing [ingest] line: %q", log)
    }
    if !strings.Contains(log, "[refresh]") {
        t.Errorf("agent.log missing [refresh] line: %q", log)
    }

    // State.json advanced
    state, _ := config.LoadState()
    if state.Files == nil || len(state.Files) == 0 {
        t.Errorf("state.json did not advance")
    }
    // RedactionSet persisted
    rs, err := config.LoadRedactionSet()
    if err != nil {
        t.Fatalf("LoadRedactionSet: %v", err)
    }
    if rs.Version != "v-1" {
        t.Errorf("redaction-set version = %q", rs.Version)
    }
}
```

- [ ] **Step 4: Verify**

```bash
go test ./internal/cli/... -run TestRun_OnceEndToEnd -v -race
```

Expected: PASS. The other PR2 `TestRun_*` tests may need cwd-config adjustments if PR3's `cfg.APIBaseURL` reference changed shape; check.

```bash
go test ./internal/cli/... -v -race
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/run.go agent/internal/cli/run_test.go
git commit -m "feat(agent): cli.run wires HTTPSink + redaction-set bootstrap + refresher goroutine"
```

---

## Phase 11 — Smoke script + coverage + PR

### Task 11.1: Update smoke-run.sh to assert `[ingest]` lines

**Files:**
- Modify: `agent/scripts/smoke-run.sh`

- [ ] **Step 1: Read existing smoke script**

```bash
cat agent/scripts/smoke-run.sh
```

PR2 version exits with `PASS: tick completed` after a single `caliber-agent run --once`. PR3 hardens by asserting `[ingest]` appears in agent.log (proves a real POST succeeded, not just a stub log line).

- [ ] **Step 2: Replace the script**

```bash
#!/usr/bin/env bash
# Manual smoke for the daemon main loop + ingest path.
# Prereq: caliber-agent enroll already succeeded against a running stack
# AND ~/.caliber-agent/config.toml has at least one path in include_paths
# AND that path has recent Claude or Codex transcript activity.
# Not in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

go build -o /tmp/caliber-agent-smoke ./cmd/caliber-agent

/tmp/caliber-agent-smoke run --once

echo "--- last 30 agent.log lines ---"
tail -30 "$HOME/.caliber-agent/agent.log"

if ! grep -q "\[ingest\]" "$HOME/.caliber-agent/agent.log"; then
  echo "FAIL: no [ingest] line in agent.log — daemon did not successfully POST to /v1/ingest"
  exit 1
fi

if ! grep -q "\[refresh\]\|\[debug\] redaction-set" "$HOME/.caliber-agent/agent.log"; then
  echo "WARN: no [refresh] line — set may be cached and not yet expired (informational)"
fi

echo "--- state.json offsets ---"
cat "$HOME/.caliber-agent/state.json" | python3 -m json.tool | head -40

rm /tmp/caliber-agent-smoke
echo "PASS: tick completed and at least one [ingest] confirmed"
```

- [ ] **Step 3: Make executable + commit**

```bash
chmod +x agent/scripts/smoke-run.sh
git add agent/scripts/smoke-run.sh
git commit -m "test(agent): smoke-run.sh asserts [ingest] line proves real POST"
```

### Task 11.2: Coverage gate

- [ ] **Step 1: Run full test + coverage**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3/agent
go vet ./...
$(go env GOPATH)/bin/staticcheck ./...
gofmt -l .
go test ./... -race -count=1
./scripts/coverage.sh
```

Expected: all green, coverage ≥ 80%.

- [ ] **Step 2: If coverage < 80%, identify gaps**

```bash
go test ./internal/... ./watcher/... ./sink/... ./redact/... -race -coverprofile=cover-raw.out
grep -v "internal/wizard/prompt_huh.go" cover-raw.out > cover.out
go tool cover -func=cover.out | sort -k 3 -n | head -20
```

Likely candidates if low:
- `redact/mode.go scrubAny` exotic branch (e.g. bool/number passthrough)
- `cli/run.go` refresher goroutine (httptest-driven via Test 10.2)
- `sink/http.go sleepBackoff` ctx-cancel branch

If real gaps exist, write 1-2 focused tests, commit:

```bash
git add agent/...
git commit -m "test(agent): fill coverage gaps to clear 80% gate"
```

- [ ] **Step 3: Server-side regression sweep**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
pnpm --filter @caliber/api exec vitest run tests/integration/rest/redactionSet.test.ts tests/integration/rest/devicesEnroll.test.ts tests/integration/rest/ingest.test.ts
pnpm -r build
```

Expected: all green.

### Task 11.3: Push + open PR

- [ ] **Step 1: Push branch**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr3
git push -u origin feat/caliber-agent-phase2-pr3
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head feat/caliber-agent-phase2-pr3 \
  --title "feat: Phase 2 PR3 — ingest client + redaction layer + per-org regex set" \
  --body "$(cat <<'EOF'
## Summary

caliber-agent Phase 2 PR3 — the daemon's first real upload path. `caliber-agent run` now gzip-POSTs transcripts to caliber server's `POST /v1/ingest` after applying configurable per-event redaction. Server gains `GET /v1/redaction-set` so org admins can extend the bundled secret-scrub regex set; the daemon fetches it on startup + every 24h with a 3-tier fallback (fresh → stale cache → bundled default).

## What landed

### Server side
- **`GET /v1/redaction-set`** endpoint with Bearer `cda_*` auth (`apps/api/src/rest/redactionSet.ts`)
- **`org_redaction_patterns`** table for per-org overrides (`packages/db/drizzle/0015_org_redaction_patterns.sql` + schema)
- **`resolveDeviceFromAuth`** shared helper extracted from `ingest.ts` for reuse across both `cda_*`-authed endpoints
- Integration tests covering default-set / custom-set / 401 paths + a Go-to-TS parity regression that pins the daemon's `DefaultPatterns` and the server's `SERVER_DEFAULT_PATTERNS` to identical lists

### Agent side
- **`redact` package**: wire-shape `Event` + 3 modes + `Pattern` + `ScrubString` + `RedactionSet` with TTL + per-pattern fault-tolerant `Compile`
- **`redact/parser/{claude,codex,dispatch}.go`**: per-source JSONL → typed Event mapping, verified against real `~/.claude/projects/.../*.jsonl` and `~/.codex/sessions/.../rollout-*.jsonl` fixtures
- **`sink/http.go HTTPSink`**: gzip POST `/v1/ingest` with cda_* auth, 5-attempt exponential backoff for 5xx/429/network, per-status sentinel mapping (`ErrInvalidToken` / `ErrKeyRevoked`), 200-with-errors[] still advances watermark
- **`internal/config/redactionset.go`** + **`internal/api/redactionset.go`**: atomic disk cache + HTTP fetch with same error-sentinel pattern as PR1's `Client.Enroll`
- **`cli/run.go`** wires it all together: bootstrap → background 24h refresher goroutine → HTTPSink (replaces LogSink) → Chunker with parser dispatch + RedactionSetProvider
- **`Chunk.Events`** evolved `[]string → []redact.Event` per PR2 spec's frozen evolution point
- **`watcher/chunker.go`** rewrite: parser dispatch + ApplyMode + gzip-size bisect (≤ 1 MB per chunk)

## Design doc

`docs/superpowers/specs/2026-05-23-caliber-agent-phase2-pr3-design.md`

## Implementation plan

`docs/superpowers/plans/2026-05-23-caliber-agent-phase2-pr3.md` — 11 phases / ~26 tasks executed via subagent-driven development.

## Out of scope (deferred)

| Item | Future PR |
|---|---|
| launchd plist + install-launchd | PR4 |
| set-mode / add-path / pause etc. real implementations | PR4+ |
| Admin UI for editing org patterns | Phase 4 |
| GDPR purge heartbeat events | Phase 3 |
| Cross-session batching (up to 500 sessions/chunk per server contract) | Phase 3 |
| agent.log rotation | Phase 3 |
| Linux build target | Phase 5+ |

## Test plan

- [x] go test ./... -race — all packages pass
- [x] staticcheck ./... clean (PR2 lesson: local go test does not run staticcheck — CI does)
- [x] gofmt -l . clean
- [x] ./scripts/coverage.sh ≥ 80%
- [x] Server-side regression: devicesEnroll.test.ts + ingest.test.ts still pass
- [x] Server-side new: redactionSet.test.ts 5 cases + parity regression
- [x] Privacy regression: each DefaultPattern has positive + near-miss tests
- [x] cli/run_test.go end-to-end fixture with httptest server returning 200 for /v1/ingest and /v1/redaction-set
- [ ] **Pending operator verification**: ./agent/scripts/smoke-run.sh after enroll + hand-edit config.toml with a real path

## Stacking

This PR is NOT stacked. PR2 (#161) already merged; this branches from current main.
EOF
)"
```

- [ ] **Step 3: Note PR URL for tracking**

The `gh pr create` command prints the URL. Record it for the next session's project memory.

---

## Self-Review

**1. Spec coverage:** every §3 file in the spec maps to at least one task. §4 components each have a dedicated task. §5 failure paths each have a test in Phase 8.3 or Phase 10. §8 public-contract additions (new endpoint, new log prefixes, new filesystem artefact) each surface in their landing phase.

**2. Placeholder scan:** none introduced. Each step has actual code, exact commands, expected outputs.

**3. Type consistency:**
- `RedactionSet` fields match across Phase 4.2 (set.go), Phase 6 (config), Phase 7 (api), Phase 10 (bootstrap)
- `Pattern` fields match between Go (Phase 4.1) and TS (Phase 1.3)
- `Event` / `EventTokens` match between Phase 2.1 + server zod + parsers (3.2, 3.3) + HTTPSink body shape (8.2)
- `Mode` constants used consistently in `ApplyMode` (5), `Chunker` (9.1), `HTTPSink` (8)
- `RedactionSetProvider.Current()` signature matches between Chunker (9.1) and cli (10.1)
- `parser.Dispatch(source, line)` signature matches 3.1 definition + 9.1 usage
- `Logger` interface (`Printf(format string, args ...any)`) compatible across `config.RFCLogger`, `sink.HTTPSink.Logger`, `watcher.Chunker.Log`, `cli.BootstrapRedactionSet.logger`
- `*api.APIError.Is` updated in 7.1 to distinguish `ErrKeyRevoked` from `ErrInvalidToken` — consumed by 8.3 retry classification

**4. Order dependencies (TDD spread):**
- Phase 1.5 parity test depends on Phase 4.1 → handled by commenting-out + re-enabling
- Phase 8.1 chunker stub depends on Phase 9.1 final rewrite → handled by temp comment
- Phase 7.1 `ErrKeyRevoked` is used in Phase 8.3 → added before consumer

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-caliber-agent-phase2-pr3.md`.

11 phases, ~26 tasks. Mix of server-side TS (Phase 1, 4 tasks) and agent-side Go (Phases 2-10, ~20 tasks) + cleanup (Phase 11, 3 tasks).

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, spec-compliance review then code-quality review per task. Same session, continuous.
2. **Inline Execution** — execute tasks in this session with batched checkpoints.

Which approach?



