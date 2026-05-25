package watcher

import "github.com/hanfour/ai-dev-eval/agent/sink"

// Chunker splits a TailResult into one or more Chunks. PR2 emits exactly
// one Chunk per non-empty TailResult (or zero if no events). PR3 will
// split by gzipped size targeting ~1 MB per chunk while maintaining
// line-boundary FromOffset/ToOffset alignment.
type Chunker struct{}

func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk {
	if len(tr.Events) == 0 {
		return nil
	}
	return []sink.Chunk{{
		File:            ref.Path,
		Source:          ref.Source,
		SessionID:       ref.SessionID,
		ParentSessionID: ref.ParentSessionID,
		CWD:             cwd,
		// TEMPORARY: chunker awaits Phase 9 rewrite for redact.Event support
		Events: nil,
		FromOffset:      tr.FromOffset,
		ToOffset:        tr.ToOffset,
	}}
}
