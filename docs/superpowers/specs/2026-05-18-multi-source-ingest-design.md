# Multi-Source Ingest — Gateway + Transcript Daemon for Performance Review

**Date:** 2026-05-18
**Status:** Draft (reality-checked against on-disk transcripts; O1 + O2 + O3 spiked 2026-05-18; pre-implementation)
**Predecessors:** caliber gateway body-capture + evaluator (already shipped); aide → caliber rebrand (PR #127–#133, #138–#145)
**Scope:** New ingestion path B (daemon → API) running parallel to existing path A (gateway proxy); shared schema + evaluator pipeline; multi-device, multi-user, multi-org isolation.

## Problem

Caliber today ingests LLM traffic only via path A: end-user re-points `claude code` / `codex` CLI's base URL to `caliber-gateway`, authenticates with a caliber-issued `ak_*` token, and `caliber-gateway` proxies to anthropic / openai upstream while body-capturing into `request_bodies`. The evaluator pipeline reads from `request_bodies` and produces `evaluation_reports`.

This works for the single-operator dogfood case (h4 with `caliber-keychain-helper`), but blocks the product target of **technical-performance reviewer for multi-user multi-device deployments**:

1. **OAuth-only Max plan** — Anthropic Max-plan users authenticate via OAuth refresh tokens stored locally (claude code keychain), not API keys. Path A requires either (a) the user surrenders their OAuth refresh token to the caliber server-side bridge, or (b) the user can't use their Max plan through the gateway at all. (a) is a non-starter for any team / company deployment — surrendering OAuth tokens of personal Max plans to a third party violates plan ToS and is a hard sell on trust.
2. **No client-side coverage of subagents and tool calls visible only in transcripts** — gateway sees the wire protocol (request/response bodies), but cannot see claude code's per-turn `Task` / subagent dispatches with full session context, internal todos, multi-step tool result chains, or `Read`/`Edit` operation metadata. Some of this surfaces in wire bodies, but the canonical record is the local JSONL transcript.
3. **Single point of friction** — every device a user wants to evaluate has to be re-configured to route through caliber's gateway. Adding a new mac or a colleague to the org means another base-URL switch and another `ak_*` token.

## Goals

1. Ship a **second ingestion path B** that requires zero changes to user auth: the user keeps their existing OAuth / API key configuration with anthropic / openai, and caliber receives a copy of the local transcripts post-hoc through a tiny daemon.
2. Path A (gateway proxy) and path B (transcript daemon) coexist and converge into the same backend tables, deduped at ingest time. The evaluator runs on a merged view; reports do not care which path the data came from.
3. Multi-tenant from day one: every event is attributable to `(org, user, device, session)`. Reviewers see only their org; org admins control retention and redaction policy.
4. **Privacy is default-on, not bolt-on**: `metadata-only` is the default ingest mode; uploading prompt/response body content is an explicit, per-device opt-in by the end-user, never a server-side override.

## Non-goals

- Replacing path A. The gateway proxy stays for users who want real-time cost tracking, body-capture-with-streaming, or who don't trust their company enough to install a daemon (and prefer auth opaque to the company).
- Real-time / streaming evaluator. Performance review is intrinsically post-hoc; daemon flushes on a minute cadence are fine.
- IDEs other than claude code + codex CLI in v1. Future: Cursor, Continue, Aider — each requires their own log shape adapter.
- Windows / Linux daemon in v1. macOS-only (homebrew + launchd) for the first ship. Linux is mostly the same code minus the launchd plist.

## Reality-check findings (2026-05-18)

Read the actual on-disk transcripts before committing to a schema. Three findings changed the design from the napkin sketch.

### Finding 1 — Claude Code has no turn_id; events are tree-structured

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, one JSON event per line, append-only. Per-event keys:

```jsonc
{
  "type": "user" | "assistant" | "attachment" | "file-history-snapshot" | "system",
  "uuid": "<event-uuid>",        // unique per event
  "parentUuid": "<event-uuid>" | null,  // tree edge; null = root
  "sessionId": "<session-uuid>",  // = filename minus .jsonl
  "isSidechain": false,           // not actually used for subagent — see Finding 3
  "timestamp": "ISO-8601",
  "message": {
    "role": "user" | "assistant",
    "content": [
      { "type": "text" | "thinking" | "tool_use" | "tool_result", ... }
    ],
    "usage": {
      "input_tokens": ..., "output_tokens": ...,
      "cache_creation_input_tokens": ...,
      "cache_read_input_tokens": ...
    }
  }
}
```

**No `turn_id` field**. A "turn" is reconstructable only by walking the `parentUuid` chain back to the last `role=user` non-tool-result event. We do that reconstruction in the **evaluator layer (a view)**, not in the physical schema, so the dedup key is `(session_id, event_uuid)` not `(session_id, turn_id)`.

### Finding 2 — Codex token usage lives in `event_msg.payload.type = "token_count"`, with `reasoning_output_tokens` broken out

`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`. First line is always `type: "session_meta"` carrying session-static fields:

```jsonc
{
  "type": "session_meta",
  "payload": {
    "id": "<session-uuid>",
    "cwd": "/path/to/project",
    "cli_version": "0.128.0",
    "originator": "codex-tui",
    "model_provider": "OpenAI",
    "base_instructions": { "text": "(full system prompt, ~10KB)" },
    "git": { "commit_hash": "...", "branch": "...", "repository_url": "..." }
  }
}
```

Subsequent events are `type: "event_msg"` (runtime events: `task_started`, `agent_message`, `exec_command_end`, `token_count`, `task_complete`) and `type: "response_item"` (model output: `function_call`, `function_call_output`, `message`, `reasoning`).

The cumulative + per-turn token usage is emitted as a separate `event_msg`:

```jsonc
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 14421, "cached_input_tokens": 11648,
        "output_tokens": 348, "reasoning_output_tokens": 189,
        "total_tokens": 14769
      },
      "last_token_usage": { ... same shape, just this turn ... },
      "model_context_window": 258400
    },
    "rate_limits": { ... codex usage caps ... }
  }
}
```

`reasoning_output_tokens` is GPT-5's thinking budget broken out from `output_tokens`. **Capture it** — it's a primary signal for cost-vs-quality evaluation (a user burning a lot of reasoning on shallow tasks looks different from one using it surgically).

Codex also emits a `turn_id` on `event_msg.payload.type = "task_started"` (form: `019dfc22-e005-7830-ba9a-58153f232b58`). Codex turns *are* identifiable by ID; claude turns are not. We keep both in the schema (nullable for claude).

### Finding 3 — Claude Code subagents are stored in `subagents/agent-<id>.jsonl`, NOT in the parent transcript with `isSidechain=true`

Search confirmed: across all my claude projects, **zero** events in main transcripts have `isSidechain: true`. Subagents (dispatched by the `Task` tool) write to:

```
~/.claude/projects/<encoded-cwd>/<parent-sessionId>/subagents/agent-<agentId>.jsonl
```

The subagent jsonl has the same per-event shape as the parent transcript, plus session-static fields on the first line (`agentId`, `cwd`, `entrypoint`, `gitBranch`, `promptId`, `userType`, `version`). The subagent's `sessionId` field is a *new* UUID, not the parent's — the relationship is encoded **in the filesystem path** (parent session UUID is the directory name), not in any in-event field. The daemon has to discover subagent files relative to the parent transcript file.

For the schema: a subagent gets its own row in `client_sessions` with `parent_session_id` set to the root session's id. Events from the subagent jsonl land in `client_events` with their own `session_id` (the subagent's UUID). Evaluator reports can choose to aggregate "session including subagents" by following the self-FK.

### Other observations

- **Single session can hit 24–27 MB** of JSONL on an active dev project. Daemon must chunk + gzip; ingest API must accept streaming.
- **First-line `attachment` events embed full SessionStart hook output** including injected skill content (10+ KB per skill). This is *system-injected context*, not user content — evaluator should down-weight or skip it when scoring user behavior. We ingest it but tag `event_type = 'hook'` so evaluator filters cleanly.
- **codex `base_instructions.text` is ~10 KB of system prompt repeated per session.** Store once on `client_sessions` (hash + optional full text), never repeat into per-event rows.
- **PII risk is high.** Cwd contains project name, git remote URL contains org/repo, tool calls include file paths and command output. Even "metadata-only" mode needs path-tail truncation rules.

## Architecture

```
┌──────────── USER DEVICE ─────────────┐
│                                       │
│  claude code / codex CLI              │
│       │                               │
│       ├──[ Path A: base URL ]──► caliber-gateway ──► anthropic/openai
│       │                              │
│       │                              ▼
│       │             body_capture (source='gateway')
│       │                              ▼
│       │                       request bodies in DB
│       │
│       └──[ writes ]──► ~/.claude/projects/  ~/.codex/sessions/
│                                      │
│                                      ▼
│                          caliber-agent (daemon)
│                          watermark + chunk + gzip
│                                      │
│                                      ▼
│                       POST /v1/ingest (source='transcript')
└───────────────────────────────────────┘
                                      │
                                      ▼
              caliber-api validates, dedupes, persists
                                      │
                                      ▼
          client_sessions + client_events + request_bodies
                                      │
                                      ▼
              evaluator pipeline (existing, reads merged view)
                                      │
                                      ▼
                       evaluation_reports
```

Both paths attribute every event to `(org_id, user_id, device_id, session_id, event_id)`. Dedup happens at insert time via a UNIQUE constraint; the evaluator never sees duplicates.

## Data model

### New tables

```sql
-- One row per physical device a user enrolls (mac, mac-mini, work laptop)
devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hostname        text NOT NULL,                -- "mbp-hanfour", "mac-mini-bamboo"
  os              text NOT NULL,                -- "darwin 25.3.0 arm64"
  agent_version   text NOT NULL,                -- daemon semver
  enrolled_at     timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at    timestamptz NOT NULL DEFAULT NOW(),
  status          text NOT NULL DEFAULT 'active',  -- 'active' | 'revoked'
  revoked_at      timestamptz
);

-- Short-lived one-shot tokens for daemon enrollment
device_enrollment_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,            -- 1hr after issue
  used_at         timestamptz,
  used_by_device_id uuid REFERENCES devices(id)
);

-- Long-lived daemon API keys (cda_ prefix = "caliber device agent")
device_api_keys (
  device_id       uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  key_hash        text NOT NULL UNIQUE,
  key_prefix      text NOT NULL,                  -- "cda_AbCdEf"
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);

-- Session-level static metadata (one row per claude/codex session and per subagent)
client_sessions (
  id                   text PRIMARY KEY,           -- session UUID from client (v4)
  parent_session_id    text REFERENCES client_sessions(id),  -- claude subagent → root
  device_id            uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_client        text NOT NULL,             -- 'claude-code' | 'claude-code-subagent' | 'codex'
  cwd                  text,                      -- nullable in metadata-only? see redaction
  git_commit_hash      text,
  git_branch           text,
  git_remote_url       text,                      -- redaction-controlled
  cli_version          text,
  model_provider       text,
  base_instructions_hash text,                    -- SHA256 of system prompt
  base_instructions_text text,                    -- nullable; only if mode = full-body
  started_at           timestamptz NOT NULL,
  last_event_at        timestamptz NOT NULL
);
-- Note on tenant safety: `id` is a single-column PK because session UUIDs are
-- v4 (collision astronomically unlikely in practice) and a composite PK would
-- force every FK chain to carry org_id. Instead, we enforce tenant isolation
-- in the ingest middleware: when a row with the same `id` already exists,
-- INSERT must match the resolved `org_id` from the cda_* key — mismatch is
-- rejected as `409 SESSION_OWNED_BY_OTHER_ORG`. See "Ingest API" below.

-- Every event (= one JSONL line) gets one row.
-- The dedup contract is the UNIQUE constraint.
-- PARTITION BY RANGE (ingested_at) MONTHLY from day 1 so retention / DROP PARTITION
-- works without REPACK on the live table. See R8 for the storage projection.
client_events (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- denormalized for index + RLS
  device_id           uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id          text NOT NULL REFERENCES client_sessions(id) ON DELETE CASCADE,
  event_id            text NOT NULL,               -- claude: uuid, codex: file_offset or seq
  parent_event_id     text,                        -- claude: parentUuid; codex: null
  turn_id             text,                        -- codex only; null for claude
  role                text,                        -- 'user' | 'assistant' | 'system' | 'tool' | null
  event_type          text NOT NULL,               -- 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'hook' | 'file_snapshot' | 'token_count' | 'task_started' | 'task_complete' | 'reasoning' | 'function_call' | 'function_call_output' | 'unknown'
  timestamp           timestamptz NOT NULL,
  content             jsonb,                       -- typed payload; mode-controlled
  input_tokens        int,
  output_tokens       int,
  cache_read_tokens   int,
  cache_creation_tokens int,
  reasoning_tokens    int,                         -- codex GPT-5 only
  source              text NOT NULL DEFAULT 'transcript',  -- 'gateway' | 'transcript'
  ingested_at         timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, ingested_at),                   -- ingested_at in PK is the postgres-partitioning requirement
  UNIQUE (session_id, event_id, source, ingested_at)  -- dedup; ingested_at appended for partition
) PARTITION BY RANGE (ingested_at);
CREATE INDEX client_events_session_ts ON client_events(session_id, timestamp);
CREATE INDEX client_events_org_ts ON client_events(org_id, timestamp);
-- Migration job creates initial partitions (current month + next 3 months);
-- a daily cron rolls forward. See Phase 1 deliverables.
```

### Existing schema deltas

```sql
-- request_bodies stays for path A's gateway captures; add device + source.
-- NOTE: client_session_id ALREADY EXISTS on request_bodies (added during
-- earlier gateway body-capture work, see packages/db/src/schema/requestBodies.ts).
-- O3 resolved that v1 does NOT populate it (no official CLI sends X-Session-Id)
-- — column stays as a Phase 5+ stub for a future caliber-claude wrapper script.
ALTER TABLE request_bodies
  ADD COLUMN device_id uuid REFERENCES devices(id),
  ADD COLUMN source text NOT NULL DEFAULT 'gateway';

-- usage_logs gets device_id too — evaluator_events view joins through it
-- and gateway-issued ak_* tokens may be bound to a device for accounting.
ALTER TABLE usage_logs
  ADD COLUMN device_id uuid REFERENCES devices(id);
-- (api_keys already has user_id + org_id; gateway populates device_id from
-- the resolved ak_* token's binding when present, NULL for legacy keys.)
```

### Evaluator-facing merged view

```sql
CREATE VIEW evaluator_events AS
SELECT
  ce.session_id, ce.event_id, ce.event_type, ce.role, ce.timestamp,
  ce.input_tokens, ce.output_tokens, ce.cache_read_tokens,
  ce.cache_creation_tokens, ce.reasoning_tokens, ce.content,
  cs.org_id, cs.user_id, cs.device_id, cs.source_client,
  cs.cwd, cs.git_commit_hash, cs.git_branch
FROM client_events ce
JOIN client_sessions cs ON cs.id = ce.session_id
WHERE ce.source = 'transcript'  -- gateway captures join through request_bodies separately

UNION ALL

-- gateway captures surface as standalone events; in v1 we do NOT join to
-- client_sessions (Resolved O3: official CLIs don't send X-Session-Id).
-- A synthetic session id = 'gw-' || request_id keeps the view shape uniform.
SELECT
  ('gw-' || rb.request_id) AS session_id,
  rb.request_id AS event_id,
  'gateway_capture' AS event_type,
  'tool' AS role,
  rb.captured_at AS timestamp,
  ul.input_tokens, ul.output_tokens, ul.cache_read_tokens,
  ul.cache_creation_tokens, NULL AS reasoning_tokens,
  jsonb_build_object('request_id', rb.request_id, 'note', 'gateway-side capture; body in request_bodies') AS content,
  rb.org_id, ul.user_id, ul.device_id, 'gateway-capture' AS source_client,
  NULL AS cwd, NULL AS git_commit_hash, NULL AS git_branch
FROM request_bodies rb
JOIN usage_logs ul ON ul.request_id = rb.request_id;
```

(View shape illustrative; final SQL adjusted to existing `request_bodies` columns.)

## Enrollment + auth flow

End-user flow (zh-TW UI):

```
1. user logs into caliber web → /dashboard/devices/new
2. user names the device ("mbp-hanfour"), picks privacy mode (default: metadata-only)
3. caliber generates enroll_token (32 random bytes, 1hr TTL, one-shot),
   displays QR + paste-text + curl one-liner
4. on the mac:
     brew install hanfour/caliber/caliber-agent
     caliber-agent enroll <enroll_token>
5. daemon: POST /v1/devices/enroll { token, hostname, os, agent_version }
6. caliber server:
     - validates token (unused, unexpired)
     - creates devices row
     - issues device_api_key (cda_<prefix>+suffix, store hash)
     - marks enroll_token used_by_device_id
     - returns { device_id, key, key_prefix }
7. daemon stores cda_* in macOS keychain (security cli, named "caliber-device-key")
8. daemon writes ~/Library/LaunchAgents/tw.caliber.agent.plist
9. launchctl bootstrap; daemon starts watching ~/.claude + ~/.codex
10. first heartbeat: PUT /v1/devices/<id>/heartbeat (updates last_seen_at)
```

Path A coexistence: a user can have **both** `ak_*` keys (for the gateway path) and `cda_*` keys (for the daemon path) at the same time. Web UI shows `/dashboard/api-keys` and `/dashboard/devices` as parallel sections.

## Daemon design

**Language + distribution:** Go, single static binary cross-compiled for `darwin/arm64`, `darwin/amd64`, `linux/amd64`. Homebrew tap: `hanfour/caliber/caliber-agent`. Fallback: `curl -sSL https://caliber.example/install.sh | sh` (script verifies SHA256 then drops binary in `/usr/local/bin`).

**Commands:**

```
caliber-agent enroll <token>      # bootstrap; one-time
caliber-agent status              # last sync time, pending bytes, error counts
caliber-agent logs                # tail daemon log (~/.caliber-agent/agent.log)
caliber-agent pause               # stop syncing (state preserved, watermark frozen)
caliber-agent resume              # resume
caliber-agent set-mode <mode>     # metadata-only | redacted-body | full-body
caliber-agent uninstall           # revoke device, remove launchd, clear keychain
```

**Project allow-list (privacy default-on):** the enrollment wizard prompts for which
project paths the daemon may watch. **Default is an empty allow-list — nothing is
uploaded until the user explicitly adds a path.** Same principle as `metadata-only`
mode: the default refuses to ship data. Paths are stored in
`~/.caliber-agent/config.toml`:

```toml
# caliber-agent config
include_paths = [
  "/Users/hanfour/work/caliber",
  "/Users/hanfour/work/some-other-project",
]
# Anything under these roots is watched. Children of an included root can be
# excluded individually via `exclude_paths` (Phase 3 regex support).
```

`caliber-agent add-path <dir>` / `remove-path <dir>` mutate the allow-list at
runtime. The daemon resolves each watched session file's `cwd` against this list
on every loop iteration; sessions outside the allow-list are skipped silently
(no watermark advance, no upload).

**Main loop:**

```
loop forever:
  for each transcript file under ~/.claude/projects/ + ~/.claude/projects/*/*/subagents/ + ~/.codex/sessions/:
    if file.cwd not under any include_paths: skip
    offset = watermark[file] from ~/.caliber-agent/state.json
    new_bytes = tail file from offset
    if no new bytes: continue
    events = parse JSONL (skip malformed lines, log + continue)
    events = redact(events, mode)
    chunks = batch into ~1 MB (gzipped) groups
    for chunk in chunks:
      POST /v1/ingest, gzipped, with device_api_key
      on 200: advance watermark[file] for this chunk
      on 401/403: pause + alert (key revoked)
      on 5xx: exponential backoff, retry
  sleep 60s
```

**Watermark persistence:** `~/.caliber-agent/state.json`:

```json
{
  "files": {
    "/Users/.../sessionId.jsonl": { "offset": 123456, "last_sync": "..." }
  }
}
```

Atomic writes (tmp + rename) so a crash mid-write doesn't corrupt state.

**Subagent discovery:** when walking `~/.claude/projects/`, the daemon also walks each session's `subagents/` subdir (one level deeper) and treats each `agent-<id>.jsonl` as a separate file with its own watermark. The first event in a subagent file is sent with `parent_session_id` populated from the parent dir name.

**Redaction layer (client-side, runs before POST):**

| Mode | content payload |
|---|---|
| `metadata-only` (default) | strip all `.message.content[].text` and `.message.content[].input` strings; replace with `{"length": N, "preview": "first_3_words..."}`. Keep tool names, file path tails (last 2 segments), event types, token counts, timestamps. |
| `redacted-body` | full content text, but apply secret-scrub regex set: `sk-[a-zA-Z0-9-_]{20,}` (anthropic + openai legacy), `sk-proj-[A-Za-z0-9_-]{20,}` (openai project keys), `sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}` (anthropic console), `AKIA[0-9A-Z]{16}` (AWS), `ghp_[A-Za-z0-9]{36,}` + `gho_[A-Za-z0-9]{36,}` + `github_pat_[A-Za-z0-9_]{82}` (github tokens), `xoxb-[A-Za-z0-9-]{40,}` (slack bot), `xoxp-[A-Za-z0-9-]{40,}` (slack user), `gsk_[A-Za-z0-9]{20,}` (groq), `Bearer\s+[A-Za-z0-9_\-\.]{20,}` (generic). `cwd` path-tail truncated to project name; git_remote_url stripped to domain only. |
| `full-body` | original content, only secret-scrub applied (still on). Used for self-dogfood by trusted single operators. |

Regex set is updatable per-org by admin (e.g. company-specific token prefixes) — daemon fetches active redaction set on enrollment + every 24h.

## Ingest API

```http
POST /v1/ingest
Authorization: Bearer cda_<key>
Content-Type: application/json
Content-Encoding: gzip

{
  "device_id": "<uuid>",
  "agent_version": "0.1.0",
  "redaction_mode": "metadata-only",
  "sessions": [
    {
      "session_id": "<uuid>",
      "parent_session_id": null,
      "source_client": "claude-code",
      "static": {
        "cwd": "/Users/.../proj",
        "git": { "commit": "...", "branch": "...", "remote": "..." },
        "cli_version": "...",
        "model_provider": "anthropic",
        "base_instructions_hash": "sha256:..."
      },
      "events": [
        {
          "event_id": "<uuid-from-client>",
          "parent_event_id": "<uuid> | null",
          "turn_id": null,
          "role": "assistant",
          "event_type": "tool_use",
          "timestamp": "...",
          "content": { ... typed payload ... },
          "tokens": {
            "input": 12, "output": 34, "cache_read": 5,
            "cache_creation": 0, "reasoning": null
          }
        },
        ...
      ]
    }
  ]
}
```

**Response shape:**

```jsonc
200 OK
{
  "ingested": 142,        // events accepted
  "deduped": 3,           // already had (session_id, event_id, source) — skipped
  "session_upserts": 2,   // client_sessions rows created or last_event_at bumped
  "errors": []
}
```

**Idempotency:**
- `client_sessions` upsert (per chunk's `sessions[]`):
  ```sql
  INSERT INTO client_sessions (id, parent_session_id, device_id, user_id, org_id, ...)
  VALUES (...)
  ON CONFLICT (id) DO UPDATE SET
    last_event_at = GREATEST(client_sessions.last_event_at, EXCLUDED.last_event_at),
    base_instructions_text = COALESCE(client_sessions.base_instructions_text, EXCLUDED.base_instructions_text)
  WHERE client_sessions.org_id = EXCLUDED.org_id;  -- tenant guard, see below
  ```
  If the `WHERE` predicate fails (existing row owned by another org), the UPDATE
  becomes a no-op and the server returns `409 SESSION_OWNED_BY_OTHER_ORG`.
- `client_events` upsert:
  ```sql
  INSERT INTO client_events (...) VALUES (...)
  ON CONFLICT (session_id, event_id, source, ingested_at) DO NOTHING;
  ```
  Daemon retries the whole chunk on 5xx; server is safe.

**Rate limits:** per-device 600 events/min default (configurable per-org). 429 = backoff. Daemon flush cadence is 60s so a heavy session ~1k events / min is on the threshold; design dial.

**Auth middleware:** `cda_*` token → `device_api_keys` → `devices` row → `org_id` + `user_id`. Server NEVER trusts `device_id` from the payload; it's overridden from the resolved key. Any mismatch is a hard 403. Session-level tenant safety: see the upsert `WHERE` guard above — a daemon claiming a session UUID already owned by another org gets 409, not silent overwrite.

## Evaluator integration

Existing evaluator pipeline reads from `request_bodies`. Change:

1. Add `evaluator_events` view (above) that unions transcript-source events and gateway-source captures.
2. Existing facet-extraction cron switches input from `request_bodies` to `evaluator_events`, scoped by `org_id`.
3. Facet schema gains transcript-only fields:
   - `subagent_call_count` (number of `Task` tool_use events)
   - `reasoning_token_ratio` (codex `reasoning_output_tokens` / `output_tokens`)
   - `tool_use_diversity` (distinct tool names per session)
   - `session_topology` (linear / branching / deep_tree from parentUuid chain)
4. LLM eval prompt gets transcript-aware variants — when source = transcript and full-body mode, the model sees actual tool calls and can score "did the user attempt the work themselves before delegating to LLM" etc.
5. Existing `evaluation_reports` adds `source_breakdown` jsonb: `{"gateway_events": N, "transcript_events": M, "overlap": K}` so reviewers can see which path produced this report's data.

## Multi-tenancy

All caliber existing tenancy machinery is reused. Hard isolation points:

- **Ingest auth**: `cda_*` token → device → org. Org_id is **server-determined**, never client-supplied. Tampering = 403.
- **Query path**: every router that returns `client_events` / `client_sessions` / `evaluation_reports` filters by `ctx.user.org_id`. Cross-org member-of check applies for reviewers covering multiple teams.
- **Evaluator LLM cost**: charged to the originating `org_id`. Existing `org_llm_cost_usd` counter (gateway side) extended to also count daemon-fed evaluator calls.
- **Retention + GDPR**: existing `gdpr_delete_requests` table extended to cascade through `client_sessions` + `client_events` keyed by `(org_id, user_id)`. Daemon receives a `purge` event during heartbeat; deletes local watermark for the affected session(s) so re-uploading does not happen.

Billing model is design-time open (per-device subscription, per-million-events ingested, per-evaluator-LLM-call); each is implementable on top of this schema with no further structural change.

## MVP phasing

**Phase 0 (already done):** path A (gateway proxy + body capture + evaluator) in production on h4; v0.6.2 cut 2026-05-18.

**Phase 1 — Schema + Ingest API (1–2 weeks)**
- drizzle migrations: `devices`, `device_enrollment_tokens`, `device_api_keys`, `client_sessions`, `client_events` (RANGE-partitioned by `ingested_at` monthly from day 1; initial partitions = current month + next 3; daily cron rolls forward)
- alter `request_bodies` to add `device_id` + `source` (NOTE: `client_session_id` already exists from earlier gateway work — not re-added)
- alter `usage_logs` to add `device_id`
- extend `gdpr_delete_requests` cascade to cover `client_sessions` + `client_events` keyed by `(org_id, user_id)` — done at Phase 1 not Phase 4, so first-day ingest is deletable
- tRPC routers: `devices.list / create / revoke`, `devices.enrollmentToken.issue`, web UI `/dashboard/devices`
- fastify route: `POST /v1/ingest` with auth middleware for `cda_*` tokens, tenant-guard on session upsert
- migration of evaluator pipeline to `evaluator_events` view
- self-dogfood readiness check: existing gateway captures keep flowing

**Phase 2 — Daemon MVP (2–3 weeks)**
- Go scaffold + launchd plist + homebrew tap
- enroll / status / pause / resume / set-mode / uninstall commands
- **interactive enrollment wizard with empty-by-default project allow-list** (`caliber-agent add-path` / `remove-path` to mutate); refuses to watch anything until user adds explicit paths
- claude-code transcript watcher (main + subagents), allow-list filtered
- codex sessions watcher, allow-list filtered
- ingest client (chunked gzipped POST, watermark persistence, exponential backoff)
- redact-secrets default pattern set (multi-provider regex set above)
- daemon dogfood: h4 + mac-mini both running it, ingest going to local caliber

**Phase 3 — Polish + privacy (1–2 weeks)**
- per-org redaction set override fetch
- per-path `exclude-projects` regex support (refinement on top of Phase 2's allow-list)
- log file rotation
- daemon ⇄ caliber TLS pinning
- auto-update mechanism (homebrew handles it for brew users; install.sh users need `caliber-agent update`)

**Phase 4 — Reviewer features (2–3 weeks)**
- per-team aggregated dashboards (cross-device)
- rubric editor improvements (transcript-aware fields)
- report export (PDF / CSV)
- GDPR delete + retention policy UI
- mobile-friendly review UI (low priority but cheap)

**Phase 5+ — Open scope**
- Windows / Linux daemon
- Cursor / Continue / Aider log adapters
- Direct API-call telemetry SDK (for users who call anthropic SDK directly, not via CLI)
- Webhook → caliber for non-local LLM usage (e.g. n8n / Zapier workflows)

## Risks + open questions

**R1 — claude code / codex transcript format drift.** Anthropic and OpenAI both control their tool's format. A breaking change ships and the daemon breaks silently or starts dropping events.
- *Mitigation*: parser is permissive — unknown fields ignored, unknown event types stored with `event_type='unknown'` + raw payload preserved. Daemon logs schema mismatch counts in `status` output. Caliber server publishes a `compatibility_min_version` per source_client; daemon refuses to ingest below that and surfaces to user.

**R2 — PII / company secrets in prompts.** End user pastes a customer's PII into claude code; transcript captures it; daemon ships it to caliber even in `metadata-only` mode (path tail still in `cwd`).
- *Mitigation*: opt-in consent dialog at first daemon run, explicit per-mode confirmation. Org admin signs DPA before `full-body` mode is selectable. Server logs every `redaction_mode=full-body` ingest to an audit table. Path-tail truncation is mandatory even in full-body for `cwd` fields.

**R3 — Reviewer ⇄ reviewee trust.** "My manager reads my prompts" is the political viability question. If end users distrust caliber, they pause the daemon during sensitive work, evaluation becomes a fiction.
- *Mitigation*: `metadata-only` default means no prompt body is ever uploaded unless the end user explicitly opts in. Reviewer reports are deterministic facets (subagent count, tool diversity, reasoning ratio, error rate) computable from metadata alone — full-body is for narrative review, not numeric scoring. Org admin role is separate from reviewer role; reviewer cannot raise the redaction mode on someone else's device.

**R4 — Anthropic / OpenAI ToS.** Uploading transcripts of conversations to a third-party server for analysis.
- *Mitigation*: caliber is the user's own data (or their employer's, where employer ⇄ employee terms apply). Not redistribution to public. Anthropic Max plan ToS reviewed pre-ship; if friction, fall back to "caliber is a self-hosted tool" framing (operator runs caliber on their own infrastructure → no third-party redistribution).

**R5 — Daemon as attack surface on the user's mac.** A compromised daemon could exfiltrate everything in `~/.claude` + `~/.codex` + watch arbitrary other dirs.
- *Mitigation*: daemon is single-purpose, no shell execution capability, no arbitrary HTTP — talks only to one configured caliber server (URL pinned at enroll). Source code open; reproducible builds. Daemon installer signs binaries with hanfour's Apple Developer ID once we get to commercial.

**R6 — Cost of LLM evaluator on path-B-only sessions.** Every event added to evaluator_events potentially triggers facet extraction. A user with a 27 MB session can produce 10k+ events.
- *Mitigation*: facet extraction is per-turn (= per parent_chain group), not per-event. Existing evaluator already caches per-turn. Cost scaled by reasonable orders of magnitude.

**R7 — Single session 24 MB stress test.** Ingest of a fresh session catch-up after daemon pause could be 100 MB of JSONL.
- *Mitigation*: chunked + gzipped ingest; rate-limit awareness; server-side streaming JSON parse (don't load whole batch in memory).

**R8 — `client_events` row-count explosion.** 100 devices × 5 MB/day of new JSONL × 365d ≈ 180 GB/year in a single table. Even modest team adoption pushes the table past comfortable single-table operational limits; index rebuild + VACUUM become painful; retention sweeps become slow DELETE storms.
- *Mitigation*: `client_events` is `PARTITION BY RANGE (ingested_at)` MONTHLY from day 1. Retention = `DROP PARTITION` (instant) instead of DELETE. Per-org retention policy (UI in Phase 4) selects which partitions to keep per `org_id` via partial drops or per-partition `DELETE WHERE org_id = X`. Initial partition window: current + next 3 months, rolled forward daily by cron. GDPR cascade implemented at Phase 1 (not Phase 4) so first-day data is purgeable.

**R9 — Secret-scrub regex bypass via encoded variants.** A user pastes `base64(api_key)` or a token-in-camelCase variable name; static regex misses it; secret lands in `redacted-body` ingest.
- *Mitigation*: regex set is best-effort, not safety net. The hard guarantee is `metadata-only` (default) — body content is not uploaded at all in that mode. `redacted-body` is a documented-best-effort tier; the org policy may forbid it for high-sensitivity environments. Future: layer an entropy / known-prefix heuristic on top of regex (Phase 3+).

**Resolved O1 — turn reconstruction from claude code parent chain (spiked 2026-05-18)**: ran a linear-scan + reverse-map reconstruction in Python over a real 21 MB / 7,674-line / 6,258-uuid session (`3e80e6a0-...jsonl`). Result: **0.43s wall time, 11.8 MB peak RSS** — trivial on any modern hardware, Go implementation will be 5–10× faster. Found **24 out-of-order `parentUuid` references** in the file, but all 24 are `type="attachment"` events (SessionStart hook output, etc.) whose `parentUuid` forward-references a later event in the same file. The "real" user/assistant message chain is strictly in-order. **Implication**: (a) the algorithm doesn't need an out-of-order buffer for the message chain — single-pass linear scan with reverse-map works; (b) `client_events.parent_event_id` must remain a plain `text` column, NOT a foreign key, because attachment events legitimately reference UUIDs not yet inserted; (c) turn reconstruction at evaluator time should filter `event_type IN ('hook', 'file_snapshot')` before walking the parent chain so attachments don't pollute turn boundaries. Existing schema already covers this.

**Resolved O2 — codex `event_msg.token_count` cadence (spiked 2026-05-18)**: walked the real codex session timeline. `token_count` does **NOT** correspond to a turn — it emits at streaming chunk boundaries during a single user→assistant turn. Each `token_count` is emitted **twice** in adjacent positions (~1.5s apart, identical values) — once mid-stream, once on final. Between any two `token_count` pairs there are typically 4–10 `response_item` events (function_call, function_call_output, reasoning). `last_token_usage` is "tokens used since the previous `token_count` event," not "tokens for the current turn." Critically: **codex `response_item` payloads have no `usage` / `tokens` field** (verified: payload keys are `arguments / call_id / content / encrypted_content / name / output / phase / role / summary / type`). The only source of token info on codex side is the `event_msg.token_count` stream. **Implication for schema**: (a) codex events land in `client_events` with `tokens = NULL` except for the `event_msg.token_count` rows themselves, which carry the snapshot in `input_tokens / output_tokens / reasoning_tokens` columns; (b) evaluator-side turn-token attribution is `cumulative_at_turn_end − cumulative_at_turn_start` (using `total_token_usage.total_tokens` snapshots), not summing per-event tokens; (c) the duplicate `token_count` pairs are de-duped at the evaluator level by `(session_id, total_tokens, output_tokens)` exact match — NOT at ingest, deliberately: the daemon ships events verbatim so future codex-format quirks can be hot-fixed server-side without re-deploying every daemon. Documented as an evaluator-layer concern, no schema change needed.

**Resolved O3 — gateway path's `client_session_id` populating (spiked 2026-05-18)**: caliber gateway already has `request_bodies.client_session_id` column and `extractSessionId(req)` middleware reading `X-Session-Id` header (`apps/gateway/src/runtime/bodyCapture.ts:111-114`), but **291 historical request_bodies rows have 0 populated `client_session_id`**. User-Agent distribution: 241× `codex-tui/0.130.0`, 36× `claude-cli/2.1.x` — neither official CLI sends an `X-Session-Id` header. Server-side strong join (option a) is not achievable without upstream CLI cooperation. **Decision: v1 does not join.** Gateway capture and transcript ingest are two independent streams in `evaluator_events`; the merged view does not perform `(user, timestamp ± window)` fuzzy matching either (cheap to add later if proven necessary). Users running both A and B simultaneously (e.g. self-dogfood) will see the same conversation as two source rows — accepted, surfaced in the reviewer UI with a `source_breakdown` chip. Realistically, 99% of users will choose only one path (B for zero-touch teams, A for power-user solo operators wanting real-time cost), so double-counting is a corner case, not a default. Future option if friction matters: a `caliber-claude` / `caliber-codex` wrapper script that injects `X-Session-Id` from the active CLI session into the gateway request — but that's Phase 5+ scope.

**Open O4 — billing model.** Subscription vs metered vs hybrid is a product question we defer past Phase 4. Schema does not force a choice.

**Open O5 — `base_instructions_text` storage growth.** Stored inline on each `client_sessions` row, the ~10 KB codex system prompt is duplicated per session. At 100 devices × ~50 sessions/day × 365d × 10 KB ≈ 18 GB/year of mostly-duplicate text. Acceptable for v1 (small fraction of `client_events` volume per R8), but if it becomes load-bearing, factor out to a `base_instructions(hash text PK, text text)` dedup table and reference by hash. Defer until measured.

## Predecessors and references

- Existing gateway body-capture: `apps/gateway/src/middleware/bodyCapture.ts`
- Existing evaluator pipeline: `apps/api/src/services/llmEvalKeyProvisioning.ts` + DB tables `request_bodies`, `request_body_facets`, `evaluation_reports`
- i18n catalogue infrastructure (PR #135–#145) carries over verbatim for reviewer UI strings
- caliber-keychain-helper (memory: `~/.caliber/keychain.token`) is unrelated to this design — it's path A's OAuth bridge for h4's single-operator gateway and stays where it is
