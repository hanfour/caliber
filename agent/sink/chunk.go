// Package sink defines the contract between the watcher loop and any
// "send a chunk somewhere" implementation. PR2 ships a stub LogSink;
// PR3 replaces it with a real HTTP ingest client. The Chunk type and
// Sink interface are frozen at PR2 (spec §4.1, §4.2).
package sink

import "github.com/hanfour/ai-dev-eval/agent/redact"

// Chunk is the unit of work passed from the watcher loop to a Sink.
// FromOffset/ToOffset bracket the CONSUMED byte range for the file —
// not "before/after events". This is load-bearing because Tail may
// advance offsets over whitespace or oversize-dropped bytes that are
// NOT in Events. PR3 server-side dedupe keys on (session_id,
// event_uuid), not byte offsets.
//
// PR3 evolves Events from raw JSONL strings ([]string) to typed
// redact.Event values produced by watcher/chunker (parser dispatch +
// ApplyMode). All other fields keep their PR2 contracts.
type Chunk struct {
	File            string // absolute path of the source transcript
	Source          string // "claude" | "claude-subagent" | "codex"
	SessionID       string
	ParentSessionID string         // claude-subagent only; "" otherwise
	CWD             string         // resolved cwd at scan time (must be in cfg.IncludePaths)
	Events          []redact.Event // typed events produced by per-source parsers + ApplyMode
	FromOffset      int64          // consumed-byte range start; equals watermark before this tail run
	ToOffset        int64          // consumed-byte range end; loop advances watermark to this
}
