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
