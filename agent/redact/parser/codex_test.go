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
