# Plan — Evaluator scores ingested telemetry (client_sessions) — #257

**Date:** 2026-07-07
**Predecessor:** `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` (Phase 1 schema already shipped: migrations 0013/0014 landed `client_sessions`, `client_events`, the `evaluator_events` view, `evaluation_reports.source_breakdown`, and transcript-only facet columns).
**Goal (operator's mental model, confirmed):** a member authorizes ONCE with `caliber login`; the resident agent continuously harvests every `claude` / `codex` interaction into `client_sessions`/`client_events`; the evaluator scores THAT, so daily scores need no gateway, no `ak_` key, no BYOK.

## Current gap (evidence)

`apps/gateway/src/workers/evaluator/runRuleBased.ts` reads ONLY `usage_logs` → `request_bodies` → `request_body_facets` (gateway path). A member whose Claude Code runs on their own subscription without the gateway produces zero evaluator input, even though full-body transcripts already sit in `client_events` (live: 1,187 sessions for the first pilot). `scoreWithRules` (`packages/evaluator`) is a **pure function** over `UsageRow[]`/`BodyRow[]`/`FacetRowInput[]` — the only thing missing is a fetch/shape layer that turns telemetry into those rows.

## Design decisions (locked)

### D1 — Merge, don't fork or collide
One `evaluation_reports` row per `(userId, periodStart, periodType)` (the existing unique key — **no migration**). `runRuleBased` additionally fetches transcript-derived `UsageRow[]`/`BodyRow[]` for the window and **concatenates** them with the gateway rows before the single `scoreWithRules` call. Rationale: matches the design doc's "reports don't care which path the data came from" and the `source_breakdown` counts-under-one-report semantics; avoids the overwrite hazard of two rows on one unique key.

- Empty-window skip fires only when BOTH sources are empty.
- `upsertEvaluationReport` gains a `sourceBreakdown` param → writes `{ gateway_events, transcript_events }` (column already exists, currently NULL everywhere).

### D2 — Org gate: reuse `content_capture_enabled`, generalize its meaning
The cron (`cron.ts`) already enqueues a per-person job for **every member** of every org with `content_capture_enabled = true` (no traffic filter). So flipping that one flag on for an org makes the cron enqueue all its members; the merged `runRuleBased` then finds their transcripts even with zero gateway usage. **No cron change, no new flag, no migration.** The flag's meaning generalizes from "capture gateway bodies" to "score this org's captured data (gateway bodies and/or device transcripts)". Documented as such. (Future refinement, out of scope: a separate `telemetry_eval_enabled` if an org wants transcript scoring without gateway capture — deferred; the member's enroll-time full-body opt-in is already the per-user consent per the design doc's privacy philosophy.)

### D3 — Transcript → row mapping (`client_events.content` IS the Anthropic `message.content[]`)
Confirmed against live data: `client_events.content` stores the raw Anthropic `message.content[]` array (thinking/text/tool_use for assistant, text/tool_result for user). Mapping, per **session** (a session = one conversation; reconstruct turns by walking `parentEventId`, but v1 can aggregate at session grain to keep the first slice tractable):

- **UsageRow** (one per usage-bearing assistant event): `requestId = "tx-" + sessionId + "-" + eventId` (synthetic, collision-free vs gateway `requestId`s); `requestedModel` from the session's model (see below); token fields straight from `client_events.{input,output,cache_read,cache_creation}Tokens`; `totalCost` computed via the existing pricing table (`model_pricing`) or 0 when model unknown (cost signals degrade gracefully — `threshold`/`cache_read_ratio` still work off tokens).
- **BodyRow** (one per assistant event, giving keyword/refusal/tool_diversity/iteration signals their data): `responseBody = { content: <assistant content[]>, stop_reason: <derived> }`; `requestBody = { model, messages: [{ role:"user", content:<preceding user content[]> }] }`; `clientSessionId = sessionId`; `clientUserAgent = sourceClient` (claude-code / codex → the `client_mix` signal).
- **Model extraction**: `client_sessions.modelProvider` is often null (live data shows empty); the concrete model id is not a clean column. v1: best-effort parse from an assistant event if present, else leave `requestedModel = "unknown"` (model_diversity degrades to 1; acceptable for v1, tracked as a follow-up to persist model on ingest).
- Redaction: `metadata-only` events have `content` with text stripped to `{length, preview}` — keyword signals see little but token/threshold signals still score. That's correct (privacy-preserving members get metric-based scores, not content-based).

### D4 — Reuse everything downstream
`scoreWithRules`, `rubricResolver`, `runEvaluation` phases (LLM deep analysis, facet extraction, ledger), and the dashboard report pages are all **unchanged** — they consume the merged `Report`. Per-key (`evaluation_reports_by_key`) path is gateway-only for v1 (devices own sessions, not api_keys — telemetry has no per-key grain); explicitly out of scope.

## Implementation phases (TDD)

1. **`transcriptRows.ts`** — pure-ish `fetchTranscriptRows(db, {orgId, userId, periodStart, periodEnd})` → `{ usageRows, bodyRows, transcriptEventCount }`. Unit/integration test against seeded `client_sessions`/`client_events` asserting the row shapes (esp. that a tool_use-bearing assistant event yields a BodyRow whose responseBody drives `tool_diversity`).
2. **Wire into `runRuleBased`** — concatenate transcript rows; fix the empty-skip to consider both; thread `transcriptEventCount`/gateway count out for `sourceBreakdown`. Integration test: a user with ONLY transcript data (zero usage_logs) now produces a non-skipped report.
3. **`upsertEvaluationReport` + `runEvaluation`** — add `sourceBreakdown`; populate on write. Test the column is set.
4. **End-to-end evaluator integration test** — seed transcript-only user in a `content_capture_enabled` org → run the worker → assert an `evaluation_reports` row with totalScore > 0 and `source_breakdown.transcript_events > 0`.
5. **Docs** — note the generalized `content_capture_enabled` semantics in the settings copy / CHANGELOG.

## Rollout
Server-only change (gateway worker + api). Release `v0.20.0` → VPS deploy (no migration). Then flip `content_capture_enabled = true` for OneAD → Steve's existing 1,187 sessions get scored on the next cron (or an admin `reports.rerun`). Interim gateway-based scoring path is untouched.
