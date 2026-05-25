# caliber-agent Phase 2 PR3 — Ingest client + redaction layer

**Date:** 2026-05-23
**Author:** brainstorming session (h4 + Claude)
**Status:** Approved design, pending implementation
**Parent specs:**
- `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` (Phase 2 — Daemon MVP, §"Ingest API", §"Redaction layer")
- `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md` (PR1 scaffold + enroll)
- `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md` (PR2 watcher + Sink/Chunk frozen contract)
**Depends on:** PR1 (#160) + PR2 (#161) merged into main (commits `8e1843d` + `5b17a56`)
**Tracking PR:** to be created

---

## 1. Goal

Land caliber-agent Phase 2 PR3 — replace PR2's `LogSink` stub with a real HTTP ingest client that gzip-POSTs transcripts to caliber server's `POST /v1/ingest`, add GDPR-compliant per-event redaction with three configurable modes, and fetch a per-org redaction regex set from a new server endpoint `GET /v1/redaction-set` on enrollment + every 24h. Single PR mixes server-side (TypeScript) + agent-side (Go) changes per user scope decision (Option C from brainstorming).

The success criterion for PR3: after PR1 enrollment + PR2 watcher are in place, `caliber-agent run --once` produces `[ingest]` log lines, the device's `last_seen_at` updates on the dashboard, and the `client_events` table in caliber receives redacted events.

---

## 2. Non-Goals (explicit)

- launchd plist + `install-launchd` command (PR4)
- Real implementations of stubbed commands (`add-path`, `remove-path`, `pause`, `resume`, `set-mode`, `uninstall`) — PR4+
- Admin UI for editing org redaction patterns — Phase 4 (the table + endpoint ship, but no UI in PR3)
- GDPR heartbeat `purge` events from server → daemon (Phase 3)
- Linux build target (Phase 5+)
- Watermark observability dashboard / per-source ingest metrics (Phase 3)
- Per-org redaction-set audit logging (Phase 3)
- Sub-second cwd change detection (still 60s polling per PR2)

---

## 3. Repo Layout

PR3 adds:
- 3 new server files + 1 migration + 1 server.ts route registration
- 12 new agent files (8 source + 4 test) across 3 packages (`agent/redact/`, `agent/sink/http.go` + `_test.go`, `agent/internal/{api,config}/redactionset.go` + tests)
- 4 modify-existing agent files

```
ai-dev-eval/
  apps/api/                                    ← server-side
    src/rest/
      redactionSet.ts                          NEW: GET /v1/redaction-set
    src/db/schema/
      orgRedactionPatterns.ts                  NEW: org_id PK FK, patterns jsonb, updated_at
    drizzle/
      0015_org_redaction_patterns.sql          NEW
    tests/integration/rest/
      redactionSet.test.ts                     NEW
    src/server.ts                              MODIFY: register new route
  agent/
    internal/
      cli/
        run.go                                 MODIFY: LogSink → HTTPSink + refresher goroutine
        run_test.go                            MODIFY: httptest end-to-end (ingest + redaction-set)
      config/
        redactionset.go                        NEW: Load/Save + RedactionSetPath
        redactionset_test.go                   NEW
      api/
        redactionset.go                        NEW: Client.FetchRedactionSet
        redactionset_test.go                   NEW
    redact/                                    NEW package
      event.go                                 wire-shape Event struct
      mode.go                                  ApplyMode(event, mode, patterns) → Event
      mode_test.go
      regexes.go                               DefaultPatterns + ScrubString
      regexes_test.go
      set.go                                   RedactionSet + IsExpired + Compile + DefaultSet
      set_test.go
      parser/
        claude.go                              ParseClaudeEvent
        claude_test.go
        codex.go                               ParseCodexEvent
        codex_test.go
        dispatch.go                            Dispatch(source, line)
    sink/
      chunk.go                                 EVOLVE: Events []string → []redact.Event
      http.go                                  NEW: HTTPSink
      http_test.go                             NEW
      log.go                                   KEEP for --once dev/debug; HTTPSink coexists
    watcher/
      chunker.go                               MODIFY: parser dispatch + ApplyMode + size split
      chunker_test.go                          MODIFY: multi-chunk-per-file regression
    scripts/
      smoke-run.sh                             MODIFY: assert [ingest] in agent.log
```

### Module boundaries (frozen at PR3)

| Package | Owns | Does NOT do |
|---|---|---|
| `redact/parser` + `redact/parser/<source>` | per-source JSONL → typed Event | redaction, HTTP, file I/O |
| `redact` (event/mode/regexes/set) | per-event redaction; regex set load/refresh/cache | parsing, HTTP |
| `internal/config/redactionset` | `~/.caliber-agent/redaction-set.json` atomic save/load + TTL check | HTTP fetch, redaction application |
| `internal/api/redactionset` | `GET /v1/redaction-set` HTTP client | parsing JSONL, applying patterns |
| `sink/http` | gzip POST `/v1/ingest` + retry/backoff + auth + error → sentinel mapping | parsing events, applying redaction |
| `watcher/chunker` | parser dispatch + apply mode + size-driven chunk split | network, redaction internals |
| `cli/run` | DI wiring + redaction-set background refresher goroutine | business logic |

Main flow (one-line): `run` startup → first fetch (or load cached) RedactionSet → spawn 24h refresher → `Loop.Tick` → per-ref parse via source-specific parser → `redact.ApplyMode` per event with cfg.Mode + current patterns → `Chunker` splits by ~1 MB gzipped size → `HTTPSink.SendChunk` (gzip + POST + retry) → on 200 advance watermark → `SaveState`.

---

## 4. Components

### 4.1 `redact/event.go` — wire-shape Event (frozen at PR3)

```go
package redact

import "time"

// Event is wire-compatible with server zod schema
// (apps/api/src/rest/ingest.ts:38-48).
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

Pointer ints distinguish absent from zero. `Content` is `any` because per-source content shapes differ; server-side zod accepts `unknown`.

### 4.2 `redact/parser/{claude,codex,dispatch}.go`

```go
package parser

import "github.com/hanfour/ai-dev-eval/agent/redact"

var ErrSkipLine = errors.New("parser: skip non-event line")

func ParseClaudeEvent(line string) (redact.Event, error)
func ParseCodexEvent(line string)  (redact.Event, error)
func Dispatch(source string, line string) (redact.Event, error)
```

**Claude line shape → Event** (verified against `~/.claude/projects/.../*.jsonl`):
- `uuid` → `EventID`
- `parentUuid` → `ParentEventID`
- `type` (`user` / `assistant` / `system` / `tool_result`) → `EventType`
- `timestamp` → `Timestamp`
- `message.role` → `Role`
- `message.content` → `Content`
- `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` → `Tokens`
- `type ∈ {"queue-operation", "summary"}` → `ErrSkipLine`

**Codex line shape → Event** (verified against `~/.codex/sessions/.../rollout-*.jsonl`):
- `payload.id` → `EventID`
- `payload.parent_id` → `ParentEventID`
- `payload.type` → `EventType`
- `timestamp` (top-level, not `payload.timestamp`) → `Timestamp`
- `payload.role` → `Role`
- `payload.content` or `payload.result` → `Content`
- `payload.usage` → `Tokens`
- `type == "session_meta"` → `ErrSkipLine` (CodexSource already used it for cwd)

**Dispatch**: `"claude"` or `"claude-subagent"` → `ParseClaudeEvent`; `"codex"` → `ParseCodexEvent`. Unknown source → error.

### 4.3 `redact/regexes.go` — DefaultPatterns + ScrubString

```go
type Pattern struct {
    Name        string         `json:"name"`
    Regex       *regexp.Regexp `json:"-"`     // compiled at runtime from RegexSrc
    RegexSrc    string         `json:"regex"`
    Replacement string         `json:"replacement"`
}

var DefaultPatterns = []Pattern{
    {Name: "anthropic_or_openai_legacy", RegexSrc: `sk-[a-zA-Z0-9_\-]{20,}`, Replacement: "sk-***"},
    {Name: "openai_project",             RegexSrc: `sk-proj-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-proj-***"},
    {Name: "anthropic_console",          RegexSrc: `sk-ant-api[0-9]{2}-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-ant-***"},
    {Name: "aws_access_key",             RegexSrc: `AKIA[0-9A-Z]{16}`, Replacement: "AKIA***"},
    {Name: "github_pat",                 RegexSrc: `ghp_[A-Za-z0-9]{36,}`, Replacement: "ghp_***"},
    {Name: "github_oauth",               RegexSrc: `gho_[A-Za-z0-9]{36,}`, Replacement: "gho_***"},
    {Name: "github_pat_fine_grained",    RegexSrc: `github_pat_[A-Za-z0-9_]{82}`, Replacement: "github_pat_***"},
    {Name: "slack_bot",                  RegexSrc: `xoxb-[A-Za-z0-9\-]{40,}`, Replacement: "xoxb-***"},
    {Name: "slack_user",                 RegexSrc: `xoxp-[A-Za-z0-9\-]{40,}`, Replacement: "xoxp-***"},
    {Name: "groq",                       RegexSrc: `gsk_[A-Za-z0-9]{20,}`, Replacement: "gsk_***"},
    {Name: "bearer_generic",             RegexSrc: `Bearer\s+[A-Za-z0-9_\-.]{20,}`, Replacement: "Bearer ***"},
}

func ScrubString(s string, patterns []Pattern) string
```

Patterns serialise as JSON source strings so the fetched set can deserialise + recompile on the daemon. `DefaultPatterns` is bundled in the binary as the bottom fallback when fetch fails and no cache exists.

### 4.4 `redact/set.go`

```go
type RedactionSet struct {
    Patterns   []Pattern `json:"patterns"`
    Version    string    `json:"version"`     // server-assigned (e.g. "default-2026-05-23" or "org-<id>-v3")
    FetchedAt  time.Time `json:"fetched_at"`
    TTLSeconds int64     `json:"ttl_seconds"` // server-suggested; default 24h
}

func (r *RedactionSet) IsExpired(now time.Time) bool
func (r *RedactionSet) Compile() error        // rebuild *regexp.Regexp from RegexSrc; skip bad + log
func DefaultSet() *RedactionSet               // built from DefaultPatterns, 24h TTL, version "bundled-<binaryVersion>"
```

`Compile()` is per-pattern fault-tolerant: a single bad regex doesn't break the set; just skip + return aggregate error of bad patterns. Loop will log `[warn]` per bad.

### 4.5 `redact/mode.go`

```go
type Mode string

const (
    ModeMetadataOnly Mode = "metadata-only"
    ModeRedactedBody Mode = "redacted-body"
    ModeFullBody     Mode = "full-body"
)

func ApplyMode(e Event, mode Mode, patterns []Pattern) Event
```

Per-mode `Content` transformation:

| Field | metadata-only | redacted-body | full-body |
|---|---|---|---|
| `Content` | **stripped** → `{length: N, preview: "first_3_words..."}` | recursive string-walk + `ScrubString` | recursive string-walk + `ScrubString` (always-on per spec) |
| All other fields | passthrough | passthrough | passthrough |

`metadata-only` content preview:
- String content → first 3 whitespace-separated words
- Structured (tool_use, tool_result) → `<tool:<name>>`
- null / empty → empty string
- `length` is `len(json.Marshal(originalContent))`

`redacted-body` and `full-body` use the same recursive walker — only difference is `full-body` keeps non-scrubbed text intact while `metadata-only` strips. Spec is explicit that secret-scrub applies in BOTH `redacted-body` and `full-body` modes.

### 4.6 `internal/api/redactionset.go`

```go
type RedactionSetResponse struct {
    Patterns   []redact.Pattern `json:"patterns"`
    Version    string           `json:"version"`
    TTLSeconds int64            `json:"ttl_seconds"`
}

func (c *Client) FetchRedactionSet(ctx context.Context, token string) (*RedactionSetResponse, error)
```

Reuses PR1's `*APIError` + sentinel pattern. 401 → `ErrInvalidToken` or `ErrKeyRevoked` (the `Is` method on `*APIError` distinguishes by `ErrorTag` field). 5xx → `*APIError`. Caller decides fallback.

### 4.7 `internal/config/redactionset.go`

```go
func RedactionSetPath() string                          // <RootDir>/redaction-set.json
func LoadRedactionSet() (*redact.RedactionSet, error)   // ErrNoRedactionSet if file missing
func SaveRedactionSet(s *redact.RedactionSet) error     // atomic tmp+rename, perm 0o600

var ErrNoRedactionSet = errors.New("config: no cached redaction set")
```

Same atomic-write pattern as `config.SaveState` from PR1.

### 4.8 `sink/http.go` — HTTPSink

```go
type HTTPSink struct {
    BaseURL  string
    Token    string
    DeviceID string
    Version  string
    Mode     redact.Mode
    HTTP     *http.Client
    Retry    RetryPolicy
    Now      func() time.Time
    Log      Logger     // for [ingest] and [error] lines
}

type RetryPolicy struct {
    MaxAttempts    int           // default 5
    InitialBackoff time.Duration // default 1s (5xx + network)
    RateLimitBase  time.Duration // default 30s (429)
    MaxJitter      time.Duration // default 250ms
}

func NewHTTPSink(opts HTTPSinkOpts) *HTTPSink
func (h *HTTPSink) SendChunk(ctx context.Context, c Chunk) error
```

**SendChunk algorithm**:
1. Build `ingestBody{DeviceID, AgentVersion, RedactionMode, Sessions:[1]}` from `Chunk`. PR2 chunker is per-file = per-session; PR3 keeps 1 session per Chunk.
2. `source_client` mapping: `"claude"` or `"claude-subagent"` → `"claude-code"`; `"codex"` → `"codex"`.
3. `json.Marshal(body)` → `gzip.NewWriter` → buffer.
4. POST with headers `Authorization: Bearer <Token>`, `Content-Type: application/json`, `Content-Encoding: gzip`.
5. Response mapping:

| Status / body | Outcome |
|---|---|
| 200 with `errors: []` | parse `{ingested, deduped, session_upserts, errors}`; log `[ingest]`; return nil → advance watermark |
| 200 with `errors[…]` non-empty | log `[ingest]` with `errors=N`; **still return nil → advance watermark** (Failure C) |
| 401 `missing_token` / `invalid_token` | `*APIError` wrapping `ErrInvalidToken` (loop fatal → daemon exit 1) |
| 401 `key_revoked` / `device_revoked` | `*APIError` wrapping `ErrKeyRevoked` (loop fatal → daemon exit 0) |
| 409 `SESSION_OWNED_BY_OTHER_ORG` | `*APIError`; log `[error]`; return error → no advance (no retry) |
| 410 `token_used` / `expired` | `*APIError` (theoretical; ingest unlikely to return these) |
| 429 | retry with `RateLimitBase` exponential (30s / 60s / 120s / 240s / 480s) + jitter, max `MaxAttempts` |
| 5xx | retry with `InitialBackoff` exponential (1s / 2s / 4s / 8s / 16s) + jitter, max `MaxAttempts` |
| timeout / `net.Error` | retry like 5xx |

Each retry attempt honors `ctx`; cancel mid-attempt aborts cleanly. After retry exhaust returns wrapped `*APIError`, no watermark advance; next tick re-tails same range (server `ON CONFLICT DO NOTHING` dedups).

### 4.9 `watcher/chunker.go` — extended

```go
type Chunker struct {
    Parser          ParserFn
    Mode            redact.Mode
    SetProv         RedactionSetProvider
    GzipTargetBytes int64                 // default 1 MB
}

type ParserFn func(source string, line string) (redact.Event, error)

type RedactionSetProvider interface {
    Current() *redact.RedactionSet  // never nil; falls back to DefaultSet()
}

func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk
```

**Algorithm**:
1. For each line in `tr.Events`:
   - `event, err := c.Parser(ref.Source, line)`
   - `errors.Is(err, parser.ErrSkipLine)` → skip silently
   - other non-nil err → log `[warn] parse failed (ref=%s err=%v)`, skip
2. `redacted := redact.ApplyMode(event, c.Mode, c.SetProv.Current().Patterns)`
3. Append to single session
4. After all events: estimate compressed size by gzipping a draft body
5. If > `GzipTargetBytes`: split at event boundary; each Chunk gets correct `ToOffset` aligned to source line boundary
6. PR3 first cut: trivial split (single chunk per file if under target; halve-then-recurse if over)

### 4.10 `cli/run.go` — wire HTTPSink + refresher

`runRun` additions on top of PR2:
1. Load keychain `cda_*` token via `keychain.Get(cfg.DeviceID)`
2. Bootstrap RedactionSet:
   - `LoadRedactionSet()` → if missing or `IsExpired`, attempt `FetchRedactionSet` synchronously
   - On fetch fail with stale cache: log `[warn] redaction-set fetch failed, using stale cache age=X`, use cached
   - On fetch fail with no cache: use `redact.DefaultSet()`, log `[warn] no cached set + fetch failed, using bundled default`
   - `Compile()`; per bad pattern log `[warn] bad pattern <name>: <err>`, skip
3. Spawn background goroutine (lifetime = ctx):
   - Sleep until `Current().TTL` elapses (default 24h)
   - On wake: `FetchRedactionSet`; on success: build new set, `provider.Set(new)`, `SaveRedactionSet`, log `[refresh]`
   - On wake fetch error: log `[warn] keep current`
   - On `ctx.Done()`: return
4. Construct `HTTPSink` (replace `LogSink`)
5. Construct `Chunker` with `Parser: parser.Dispatch`, `SetProv: provider`, `Mode: cfg.Mode`
6. `watcher.NewLoop(...)` with new chunker + sink

### 4.11 Server-side: `apps/api/src/rest/redactionSet.ts`

`GET /v1/redaction-set` route:
- Bearer `cda_*` auth (reuse `resolveDevice` from `ingest.ts`)
- Resolve device → `org_id`
- `SELECT patterns FROM org_redaction_patterns WHERE org_id = ?`
- If no row: return `{patterns: <SERVER_DEFAULT_PATTERNS>, version: "default-<sha256-of-default-set-first-8>", ttl_seconds: 86400}`
- If row: return `{patterns: row.patterns, version: <sha256-of-patterns-jsonb-first-8>, ttl_seconds: 86400}`
- 401 / device_revoked / device_inactive semantics identical to `/v1/ingest`

Server-side default patterns are a TypeScript constant in `redactionSet.ts` that mirrors the agent's `DefaultPatterns`. Drift between them produces inconsistent behaviour (agent assumes patterns match server's default when fetch fails) — pin via a regression test that asserts both lists structurally match.

`drizzle/0015_org_redaction_patterns.sql`:
```sql
CREATE TABLE org_redaction_patterns (
  org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  patterns jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
```

---

## 5. Data Flow

### Startup

```
runRun
  ├─► config.Load
  ├─► keychain.Get(cfg.DeviceID) → cda_* token
  ├─► config.OpenAgentLog → logger
  │
  ├─► RedactionSet bootstrap:
  │     cached, err = config.LoadRedactionSet()
  │     if err == ErrNoRedactionSet OR cached.IsExpired(now):
  │         fresh, ferr = api.FetchRedactionSet(ctx, token)
  │         if ferr == nil:
  │             cached = { Patterns: fresh.Patterns, Version, FetchedAt:now, TTLSeconds }
  │             config.SaveRedactionSet(cached)
  │         elif cached != nil:
  │             log [warn] stale cache age=X
  │         else:
  │             cached = redact.DefaultSet(); log [warn] using bundled default
  │     cached.Compile()       // per-pattern: skip bad + log [warn]
  │     provider.Set(cached)
  │
  ├─► spawn refresher goroutine:
  │     for { sleep TTL; if ctx.Done: return
  │           fresh, err = api.FetchRedactionSet(ctx, token)
  │           if err == nil: provider.Set(new); SaveRedactionSet(new); log [refresh]
  │           else: log [warn] keep current }
  │
  ├─► loop = watcher.NewLoop with
  │       Chunker{Parser: parser.Dispatch, Mode: cfg.Mode, SetProv: provider, GzipTarget: 1<<20}
  │       Sink: sink.NewHTTPSink(...)        ← swapped from LogSink
  │
  └─► loop.Run(ctx) or loop.Tick(ctx) if --once
```

### Per-tick happy path

```
Loop.Tick                Chunker                  HTTPSink                  caliber API
   │                        │                          │                          │
   │ refs from sources, cwd resolved, tail done (PR2)                              │
   │                                                                              │
   ├──────────────────────►│ Split(ref, tr, cwd):                                  │
   │                        │   for line in tr.Events:                              │
   │                        │     evt = parser.Dispatch(ref.Source, line)          │
   │                        │     if ErrSkipLine: continue                          │
   │                        │     redacted = redact.ApplyMode(evt, Mode,            │
   │                        │                 provider.Current().Patterns)         │
   │                        │     appendTo(session.Events, redacted)                │
   │                        │   gzip-size split (PR3: trivial 1-chunk-per-file)    │
   │◄──────────────────────┤ []Chunk{{Events []redact.Event, ...}}                  │
   │                                                                              │
   ├─────────────────────────────────────────►│ SendChunk(ctx, c):                  │
   │                                            │ body = ingestBody{               │
   │                                            │   DeviceID, AgentVersion,         │
   │                                            │   RedactionMode,                  │
   │                                            │   Sessions:[{                     │
   │                                            │     SessionID, ParentSessionID,   │
   │                                            │     SourceClient (mapped),        │
   │                                            │     Static:{CWD,...},             │
   │                                            │     Events: c.Events              │
   │                                            │   }]                              │
   │                                            │ }                                 │
   │                                            │ raw = json.Marshal(body)           │
   │                                            │ gz = gzip(raw)                     │
   │                                            │ POST /v1/ingest                    │
   │                                            │   Authorization: Bearer cda_*      │
   │                                            │   Content-Encoding: gzip           │
   │                                            ├─────────────────────────────────►│
   │                                            │                  200 OK            │
   │                                            │  {ingested:N, deduped, session_upserts, errors:[]}
   │                                            │◄─────────────────────────────────┤
   │                                            │ log [ingest] sess=X events=Y ingested=N
   │◄───────────────────────────────────────────┤ nil                                │
   │ state.Files[c.File] = {Offset:c.ToOffset, LastSync:Now()}                       │
   │ SaveState (atomic)                                                              │
```

### Background refresher

Single goroutine, lifetime = ctx (= Loop). Wakes when `provider.Current().TTL` elapses. Fetches; on success atomic swap into provider + persist. Ctx-cancellable → clean SIGTERM shutdown.

### Failure paths

| ID | Trigger | Behaviour | Effect |
|---|---|---|---|
| A | parser `ErrSkipLine` | skip silently | tick continues |
| B | parser non-skip error | log `[warn] parse failed`, skip | tick continues |
| C | HTTP 200 with `errors[]` non-empty | log `[ingest] errors=N`, **DO advance watermark** | server accepted what it could; no re-send |
| D | HTTP 5xx | retry 1s/2s/4s/8s/16s + jitter, max 5; final fail → no advance | next tick re-tails same range; server `ON CONFLICT DO NOTHING` dedups |
| E | HTTP 429 | retry 30s/60s/120s/240s/480s + jitter, max 5; final fail → no advance | next tick retries |
| F | HTTP 401 `invalid_token` / `missing_token` | log `[fatal] invalid token`, return errFatal | daemon exits 1 |
| G | HTTP 401 `key_revoked` / `device_revoked` | log `[fatal] key revoked, re-enroll required`, return errFatal | daemon exits 0 (launchd won't restart) + final stderr message |
| H | HTTP 409 `SESSION_OWNED_BY_OTHER_ORG` | log `[error] cross-org collision`, return error | no advance; tenant misconfig; other refs unaffected |
| I | Ctx cancel during POST | abort via `http.Request.Context`, return ctx.Err() | SIGTERM clean shutdown (exit 130) |
| J | gzip encode error (shouldn't happen) | log `[error] gzip encode`, return error | no advance |
| K | RedactionSet fetch fail at startup (no cache) | log `[warn] using bundled default`, proceed with `DefaultSet()` | daemon runs (errs on side of more redaction) |
| L | RedactionSet fetch fail mid-flight (cache exists) | log `[warn] stale cache age=X`, keep using current | next refresh tick retries |
| M | Pattern compile error in fetched set | skip bad pattern, log `[warn] bad pattern <name>: <err>`, keep others | one bad regex doesn't break the set |

### Idempotency boundary

- Server `client_events ON CONFLICT (session_id, event_id, source, ingested_at) DO NOTHING` handles daemon retries
- Daemon at-least-once; dup count surfaces via server's `deduped` field in response
- Watermark advances **only on HTTP 200** (Failure C still 200; advance even when `errors[]` non-empty)

### External contract additions (PR3 frozen)

- **`GET /v1/redaction-set`** with Bearer `cda_*` → `{patterns: [{name, regex, replacement}, ...], version: <string>, ttl_seconds: <int>}`
- **agent.log new prefixes**:
  - `[ingest]` per successful POST: `sess=<id> events=<N> ingested=<I> deduped=<D> errors=<E> bytes=<wire> duration=<ms>`
  - `[refresh]` per redaction-set fetch: `redaction-set version=<v> patterns=<n> ttl=<s>s`
  - `[fatal]` two-line stderr+agent.log message on invalid_token / key_revoked exit
- **`~/.caliber-agent/redaction-set.json`** — perm 0o600, atomic tmp+rename, JSON shape per `RedactionSet`
- **Exit codes** (unchanged): 0 (clean / key_revoked) / 1 (config / invalid_token / fatal non-revoke) / 70 (panic) / 130 (SIGINT)

---

## 6. Error Handling Principles

1. **Tick never fails fast** (inherited from PR2). All per-event parse failures, per-chunk HTTP 5xx/429, refresh failures: log + continue. Only `ctx.Err()` aborts a Tick.

2. **Sink failure halts current ref's remaining chunks** (PR2 §6.2 contract). HTTPSink final-retry-exhaust returns error; Loop breaks the inner chunk loop for THIS ref and moves to the next ref.

3. **Watermark advances on HTTP 200** (including Failure C — 200 with errors[]). Never on 5xx/429/timeout/409.

4. **Fatal-vs-recoverable boundary**: `invalid_token` and `key_revoked` are *fatal* (daemon stops). Everything else is recoverable (next tick retries). `409 SESSION_OWNED_BY_OTHER_ORG` is recoverable from the daemon's POV but logged as `[error]` for ops investigation.

5. **Redaction set degradation**: fetch fail does NOT stop the daemon. Order of fallback: fresh fetch → cached file → bundled `DefaultSet()`. Pattern compile errors are per-pattern, not per-set.

6. **No silent error swallowing**. Every caught-and-continued error logs at appropriate severity (`[debug]` / `[warn]` / `[error]` / `[fatal]`).

7. **Stable exit codes** unchanged from PR1+PR2.

8. **`[fatal]` is special**. Two-line stderr + agent.log message on exit. Example for key_revoked:

   ```
   [fatal] device key revoked by caliber server
   Action: run `caliber-agent enroll <new-token>` to re-enroll this device
   ```

---

## 7. Testing

### Per-package coverage targets

- `redact/parser/claude`: ≥95% — fixture-driven for all observed Claude event types
- `redact/parser/codex`: ≥95% — same for Codex
- `redact`: ≥90% — three modes × multiple content shapes
- `redact/regexes`: 100% — each pattern has a positive + negative test
- `internal/api/redactionset`: ≥90% — httptest-driven happy + 401 + 5xx
- `internal/config/redactionset`: ≥95% — load/save round-trip + atomic + missing
- `sink/http`: ≥90% — happy + 401 invalid/revoked + 429 + 5xx + timeout + retry exhaust
- `watcher/chunker`: existing PR2 tests + new multi-chunk size-split test

Overall coverage gate stays at 80% (PR1 `coverage.sh`); no exclusions needed beyond PR1's `prompt_huh.go`.

### Key tests

**`redact/parser/claude_test.go`**:
- Real fixture from `~/.claude/projects/.../*.jsonl` (sanitized): `user`, `assistant`, `system`, `tool_result`, `tool_use` content, `summary`, `queue-operation`
- Each `ErrSkipLine` case asserted
- `usage` → `Tokens` round-trip for all 5 token fields
- Malformed JSON → non-skip error, not panic

**`redact/parser/codex_test.go`**:
- Real fixture from `~/.codex/sessions/.../rollout-*.jsonl`
- `session_meta` → `ErrSkipLine`
- `payload.id` → `EventID`, `payload.parent_id` → `ParentEventID`

**`redact/mode_test.go`**:
- For each of three modes × content shape (string / structured tool_use / null):
  - Result struct matches expectations
  - Original event unmodified (immutability)
  - In `metadata-only`: `Content` is `{length, preview}` with correct preview extraction
  - In `redacted-body`: API-key-shaped string in content gets `sk-***`
  - In `full-body`: scrubbing still applies (defence-in-depth)

**`redact/regexes_test.go`** — privacy regression guards:
- Each `DefaultPattern` has a positive sample that gets scrubbed
- Each pattern has a near-miss negative sample that DOESN'T get scrubbed
- `ScrubString` with empty patterns is identity
- `ScrubString` is idempotent

**`sink/http_test.go`** — load-bearing failure modes:
- Happy 200 → returns nil, body parsed, log line emitted
- 401 invalid_token → `errors.Is(err, ErrInvalidToken)` AND `errors.As(err, &apiErr)`
- 401 key_revoked → `errors.Is(err, ErrKeyRevoked)`
- 409 → `*APIError` with code, no retry, error returned
- 429 → retry RateLimitBase backoff observed (injected clock); after MaxAttempts → returned error
- 5xx → 1s/2s/4s/8s/16s backoff observed; after MaxAttempts → returned error
- 200 with `errors[]` non-empty → returns nil (advance), logs the errors
- Timeout → retries like 5xx; ctx cancel mid-attempt aborts cleanly
- gzip body has `Content-Encoding: gzip` header set
- `Authorization: Bearer cda_test_key` header set
- `source_client` correctly mapped from `claude` / `claude-subagent` / `codex`

**`internal/api/redactionset_test.go`** — httptest:
- Happy: 200 with patterns + version + ttl
- 401 → sentinel error
- 5xx → `*APIError`
- Body size cap (defensive, 64 KiB)

**`internal/config/redactionset_test.go`**:
- Load missing → `ErrNoRedactionSet`
- Save then load round-trip
- Atomic save (tmp file cleaned)
- Perm 0o600

**`watcher/chunker_test.go`** (new tests on top of PR2):
- Parser dispatch routes correctly per source
- `ApplyMode` invoked with current provider patterns
- Size-driven split: synthetic 5 MB body → multiple chunks, each ≤ ~1 MB gzipped, line-boundary aligned, monotonic `ToOffset`

**`cli/run_test.go`** — end-to-end with httptest server:
- Build daemon with fake server returning 200 for `/v1/ingest` AND `/v1/redaction-set`
- Pre-enroll, write Claude fixture, run `--once`
- Assert: refresh happened (set saved to disk); ingest POST received with gzipped body, decompresses to expected JSON shape; state.json advanced; agent.log contains both `[refresh]` and `[ingest]` lines

**Server-side `apps/api/tests/integration/rest/redactionSet.test.ts`**:
- Vitest + setupTestDb + fake security shell-out (mirror PR1's `devicesEnroll.test.ts`)
- Happy: device exists, no org row → default set returned
- Happy: device exists, org has custom row → custom set returned
- 401 `invalid_token`, `key_revoked`, `device_revoked`, `device_inactive` — all sentinel responses match shape
- **Default-set parity regression**: assert the TS-side default mirrors `agent/redact/regexes.go`'s `DefaultPatterns` structurally (test cross-reads the Go source list — keeps the two in sync)

### CI

- `agent-ci.yml` unchanged (already runs vet, staticcheck, gofmt, test, coverage)
- Server-side `lint-type-test` + `integration` workflows pick up new endpoint + migration automatically

### Local verify before push

```bash
cd agent
go vet ./...
$(go env GOPATH)/bin/staticcheck ./...      # CI-equivalent — local `go test` alone doesn't run this
gofmt -l .
go test ./... -race
./scripts/coverage.sh

cd ../apps/api
pnpm exec vitest run tests/integration/rest/redactionSet.test.ts
pnpm exec vitest run tests/integration/rest/devicesEnroll.test.ts   # regression
pnpm exec vitest run tests/integration/rest/ingest.test.ts          # regression
pnpm -r build
```

`staticcheck` listed explicitly per the PR2 lesson — `agent-ci.yml` runs it but `go test` doesn't.

---

## 8. Public Contract (frozen at PR3)

These surfaces lock once PR3 merges. Future PRs evolve, not break.

- **New server endpoint:** `GET /v1/redaction-set` with Bearer `cda_*` auth → JSON `{patterns: [{name, regex, replacement}, ...], version: <string>, ttl_seconds: <int>}`
- **Wire format for `POST /v1/ingest`** — unchanged from Phase 1 (PR #150) but now actually used: `source_client ∈ {"claude-code", "codex"}`; `events[].timestamp` ISO-8601; `redaction_mode ∈ {"metadata-only", "redacted-body", "full-body"}`
- **New agent.log prefixes:** `[ingest]`, `[refresh]`, `[fatal]`
- **New filesystem artefact:** `~/.caliber-agent/redaction-set.json` perm 0o600
- **`Chunk` type evolution:** `Events []string → []redact.Event` (planned in PR2 spec; PR3 executes)
- **`Sink` interface** unchanged from PR2 (no signature change; PR3 only adds a new implementation `HTTPSink` alongside `LogSink`)
- **Exit codes** unchanged from PR1+PR2

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Default-pattern drift between agent's `DefaultPatterns` and server's `SERVER_DEFAULT_PATTERNS` | Integration test asserts both lists structurally match; CI fails on drift |
| Per-org regex set with broken pattern (admin-introduced) | `Compile()` skips bad patterns per-pattern; daemon keeps running with good ones; ops sees `[warn]` per bad |
| Daemon DoS from large transcripts × no rate limit awareness | PR2's 20 MiB per-file-per-tick cap inherits; server-side rate limit (600 events/min default per device) returns 429 → daemon honors with exponential backoff; daemon flush cadence 60s means burst-free under load |
| Server-side `cda_*` key compromise | `device_api_keys.revokedAt` from PR1 already in place; daemon honors 401 `key_revoked` with clean exit (Failure G) |
| Redaction set fetch failure on first enroll → daemon uses bundled default | Acceptable; bundled default mirrors server default; daemon prints `[warn]` so operator notices |
| Mid-flight stale cache (TTL passed but refresh failed) | Daemon keeps using stale set + logs `[warn]`; next refresh tick retries; no service interruption |
| `metadata-only` mode preview leaks 3 words of content | Spec design choice — operator opts into this when picking the mode; for stricter use `metadata-only` is most-conservative we have without entirely dropping the event |
| Server-side `errors[]` non-empty but daemon advances watermark → some events permanently lost | Acceptable per Failure C — server already accepted what it could; re-sending would just dupe-dedup; lost events are individual events that were structurally invalid, surfaced via `[ingest] errors=N` log line so ops can investigate |
| Stacked PR mechanics (PR3 stacks on main now that PR1+PR2 are merged) | No stacking complexity in PR3 — `main` already has the agent module |

---

## 10. Out of Scope (with pointers to future PRs)

| Item | Future PR |
|---|---|
| launchd plist + `install-launchd` | PR4 |
| `caliber-agent set-mode <mode>` real implementation | PR4 |
| `caliber-agent add-path` / `remove-path` real implementations | PR4 |
| `caliber-agent pause` / `resume` real implementations | PR4+ |
| `caliber-agent uninstall` real implementation | PR4+ |
| Admin UI for editing org redaction patterns | Phase 4 |
| GDPR purge events (server → daemon heartbeat) | Phase 3 |
| Linux build target | Phase 5+ |
| `agent.log` rotation | Phase 3 |
| Cross-session batching (≤ 500 sessions/chunk per server contract) | Phase 3 |
| Per-org redaction set audit logging | Phase 3 |
| Daemon metrics endpoint / dashboard | Phase 3 |

---

## 11. References

- Parent spec: `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` §"Ingest API" + §"Redaction layer"
- PR1 spec: `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md` (scaffold + enroll + keychain + config + APIError pattern)
- PR2 spec: `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md` (watcher + Sink/Chunk frozen + Loop + cli/run.go layout)
- Server ingest impl: `apps/api/src/rest/ingest.ts` (auth pattern, zod shape, error responses)
- Server enroll impl: `apps/api/src/rest/devicesEnroll.ts` (auth pattern mirror for new endpoint)
- Verified 2026-05-23 against `~/.claude/projects/` and `~/.codex/sessions/` for event shape ground truth
