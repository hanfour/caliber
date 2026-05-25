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
//
//	uuid                                              -> EventID
//	parentUuid (null-tolerant)                        -> ParentEventID
//	type                                              -> EventType
//	timestamp                                         -> Timestamp
//	message.role                                      -> Role
//	message.content                                   -> Content
//	message.usage.{input_tokens,output_tokens,
//	   cache_read_input_tokens,cache_creation_input_tokens}
//	                                                 -> Tokens.*
func ParseClaudeEvent(line string) (redact.Event, error) {
	var raw struct {
		Type       string         `json:"type"`
		UUID       string         `json:"uuid"`
		ParentUUID *string        `json:"parentUuid"`
		Timestamp  string         `json:"timestamp"`
		Message    *claudeMessage `json:"message"`
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
