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

// #171: Claude Code transcripts interleave non-event sidecar records that
// carry no `uuid` (UI/session state). They previously fell through, got an
// empty EventID, and were dropped by the chunker with a noisy [warn]. They
// must be a silent ErrSkipLine instead. Real events always carry a uuid;
// sidecar records never do — so skip-on-missing-uuid is the invariant.
func TestParseClaudeEvent_SidecarTypesAreSkipLine(t *testing.T) {
	sidecar := []string{
		"last-prompt", "permission-mode", "ai-title", "pr-link",
		"file-history-snapshot", "worktree-state", "mode", "agent-name",
	}
	for _, typ := range sidecar {
		line := `{"type":"` + typ + `","timestamp":"2026-05-23T10:00:00Z"}`
		_, err := ParseClaudeEvent(line)
		if !errors.Is(err, ErrSkipLine) {
			t.Errorf("type %q: err = %v, want ErrSkipLine", typ, err)
		}
	}
}

// Any line lacking a uuid is skipped, even an unknown/future type — the
// server rejects empty event_id anyway, so silently skipping is correct
// and future-proof against new sidecar types.
func TestParseClaudeEvent_MissingUUIDIsSkipLine(t *testing.T) {
	line := `{"type":"some-future-sidecar","timestamp":"2026-05-23T10:00:00Z","data":{"x":1}}`
	_, err := ParseClaudeEvent(line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("no-uuid line: err = %v, want ErrSkipLine", err)
	}
}

// Regression: real event types all carry a uuid and must still parse.
func TestParseClaudeEvent_RealEventTypesWithUUIDStillParse(t *testing.T) {
	for _, typ := range []string{"attachment", "progress", "system"} {
		line := `{"type":"` + typ + `","uuid":"x-1","timestamp":"2026-05-23T10:00:00Z","message":{"role":"user","content":"c"}}`
		got, err := ParseClaudeEvent(line)
		if err != nil {
			t.Errorf("type %q: unexpected err %v", typ, err)
			continue
		}
		if got.EventID != "x-1" || got.EventType != typ {
			t.Errorf("type %q: got = %+v", typ, got)
		}
	}
}
