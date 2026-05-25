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
