package parser

import (
	"errors"
	"testing"
)

func TestDispatch_RoutesByClaudeSource(t *testing.T) {
	const line = `{"type":"queue-operation"}`
	_, err := Dispatch("claude", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("claude queue-operation should ErrSkipLine, got %v", err)
	}
}

func TestDispatch_RoutesByClaudeSubagentSource(t *testing.T) {
	const line = `{"type":"queue-operation"}`
	_, err := Dispatch("claude-subagent", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("claude-subagent should route to claude parser, got %v", err)
	}
}

func TestDispatch_RoutesByCodexSource(t *testing.T) {
	const line = `{"type":"session_meta","payload":{}}`
	_, err := Dispatch("codex", line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("codex session_meta should ErrSkipLine, got %v", err)
	}
}

func TestDispatch_UnknownSourceReturnsError(t *testing.T) {
	_, err := Dispatch("unknown", `{}`)
	if err == nil {
		t.Error("expected non-nil error for unknown source")
	}
}
