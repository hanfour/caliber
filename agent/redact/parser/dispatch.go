// Package parser converts per-source JSONL lines into wire-shape
// redact.Event values. Each source is in its own file; Dispatch
// routes by watcher.FileRef.Source value.
package parser

import (
	"errors"
	"fmt"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// ErrSkipLine signals that the line was not an event (queue-operation,
// session_meta, summary lines, etc.). Loop callers skip silently.
var ErrSkipLine = errors.New("parser: skip non-event line")

// Dispatch routes a JSONL line to the per-source parser by FileRef.Source.
//
//	"claude" or "claude-subagent" -> ParseClaudeEvent
//	"codex"                       -> ParseCodexEvent
//	anything else                 -> error
func Dispatch(source string, line string) (redact.Event, error) {
	switch source {
	case "claude", "claude-subagent":
		return ParseClaudeEvent(line)
	case "codex":
		return ParseCodexEvent(line)
	default:
		return redact.Event{}, fmt.Errorf("parser: unknown source %q", source)
	}
}
