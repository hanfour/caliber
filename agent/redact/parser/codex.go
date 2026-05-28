package parser

import (
	"crypto/sha256"
	"encoding/hex"
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
//
//	timestamp (top-level)                             -> Timestamp
//	payload.id (synthesized if absent)                -> EventID
//	payload.parent_id (null-tolerant)                 -> ParentEventID
//	payload.type (else top-level type)                -> EventType
//	payload.role                                      -> Role
//	payload.content / payload.result / payload body   -> Content
//	payload.usage.{input_tokens,output_tokens,
//	   cache_read_tokens,cache_creation_tokens,
//	   reasoning_output_tokens}                       -> Tokens.*
//
// Synthetic event_id: real codex transcripts only carry payload.id on
// session_meta; message / function_call / function_call_output /
// reasoning / token_count / task_started / ... all omit it. Server
// validation requires non-empty event_id, so when missing we emit
// "codex_<sha256(line)[:24]>". Hashing the raw line keeps the id stable
// across daemon retries of the same byte-identical transcript line,
// which is what server-side dedup keys on.
func ParseCodexEvent(line string) (redact.Event, error) {
	var raw struct {
		Type      string          `json:"type"`
		Timestamp string          `json:"timestamp"`
		Payload   json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return redact.Event{}, fmt.Errorf("parser: codex json: %w", err)
	}
	if raw.Type == "session_meta" {
		return redact.Event{}, ErrSkipLine
	}
	if len(raw.Payload) == 0 || string(raw.Payload) == "null" {
		return redact.Event{}, ErrSkipLine
	}
	var p codexPayload
	if err := json.Unmarshal(raw.Payload, &p); err != nil {
		return redact.Event{}, fmt.Errorf("parser: codex payload: %w", err)
	}
	ts, _ := time.Parse(time.RFC3339Nano, raw.Timestamp)
	eventID := p.ID
	if eventID == "" {
		eventID = synthesizeCodexEventID(line)
	}
	// Typeless-payload lines (turn_context, compacted) carry their kind at
	// the top level rather than under payload.type; fall back to it so the
	// event isn't shipped with an empty (server-rejected) event_type.
	eventType := p.Type
	if eventType == "" {
		eventType = raw.Type
	}
	ev := redact.Event{
		EventID:   eventID,
		EventType: eventType,
		Timestamp: ts,
		Role:      p.Role,
	}
	if p.ParentID != nil {
		ev.ParentEventID = *p.ParentID
	}
	switch {
	case p.Content != nil:
		ev.Content = p.Content
	case p.Result != nil:
		ev.Content = p.Result
	case p.Type == "":
		// Typeless-payload events hold their data in the payload body
		// itself (turn_context: model/cwd/effort; compacted:
		// message/replacement_history). Preserve it so the event isn't
		// an empty shell. Scoped to p.Type == "" so typed events that
		// legitimately lack content (e.g. token_count) stay nil.
		var body map[string]any
		if json.Unmarshal(raw.Payload, &body) == nil {
			ev.Content = body
		}
	}
	if u := p.Usage; u != nil {
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

// syntheticIDBytes is how many leading sha256 bytes go into a synthetic
// codex event_id. 12 bytes (96 bits, 24 hex chars) keeps collisions
// negligible across a session's events while staying well under the
// server's 200-char event_id limit.
const syntheticIDBytes = 12

// synthesizeCodexEventID derives a deterministic event_id from the raw
// JSONL line. Assumption: codex rollout logs are append-only and never
// rewrite a line, so byte-identical lines are the same logical event —
// hashing the line is therefore a safe dedup key. The only collision
// path is two truly byte-identical lines (same timestamp + payload),
// which an append-only writer does not produce.
func synthesizeCodexEventID(line string) string {
	sum := sha256.Sum256([]byte(line))
	return "codex_" + hex.EncodeToString(sum[:syntheticIDBytes])
}
