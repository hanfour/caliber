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
//	payload.type                                      -> EventType
//	payload.role                                      -> Role
//	payload.content or payload.result                 -> Content
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
	eventID := raw.Payload.ID
	if eventID == "" {
		eventID = synthesizeCodexEventID(line)
	}
	ev := redact.Event{
		EventID:   eventID,
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

func synthesizeCodexEventID(line string) string {
	sum := sha256.Sum256([]byte(line))
	return "codex_" + hex.EncodeToString(sum[:12])
}
