package watcher

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"

	"github.com/hanfour/ai-dev-eval/agent/redact"
	"github.com/hanfour/ai-dev-eval/agent/redact/parser"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

// ParserFn is the per-source JSONL line → redact.Event parser. The
// chunker dispatches by FileRef.Source. parser.Dispatch is the
// production impl; tests inject stubs.
type ParserFn func(source string, line string) (redact.Event, error)

// RedactionSetProvider lets cli/run swap the current set at refresh
// time without touching the Loop. Current() never returns nil — falls
// back to redact.DefaultSet() on miss.
type RedactionSetProvider interface {
	Current() *redact.RedactionSet
}

// Chunker parses raw JSONL lines via ParserFn, applies the current
// redaction mode + patterns, and emits sink.Chunk values sized by
// gzipped body byte target. PR3 first cut splits only when a single
// chunk would exceed GzipTargetBytes; otherwise one chunk per file.
//
// Zero-value Chunker is valid for loop integration tests that do not
// need real parsing: nil Parser skips all events, nil SetProv uses
// redact.DefaultSet().
type Chunker struct {
	Parser          ParserFn
	Mode            redact.Mode
	SetProv         RedactionSetProvider
	GzipTargetBytes int64
	Log             Logger
}

// Split takes a TailResult, parses + redacts each line, and returns
// one or more Chunks sized by gzipped budget. Per-event errors are
// logged + skipped; ErrSkipLine is silently dropped.
func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk {
	if len(tr.Events) == 0 {
		return nil
	}

	// nil Parser: emit a single chunk with no events (preserves PR2
	// watermark-advance behaviour for zero-value Chunker in loop tests).
	if c.Parser == nil {
		return []sink.Chunk{c.build(ref, nil, tr.FromOffset, tr.ToOffset, cwd)}
	}

	rs := c.currentSet()
	events := make([]redact.Event, 0, len(tr.Events))
	for _, line := range tr.Events {
		ev, err := c.Parser(ref.Source, line)
		if err != nil {
			if !errors.Is(err, parser.ErrSkipLine) {
				if c.Log != nil {
					c.Log.Printf("[warn] parse failed (ref=%s err=%v)", ref.Path, err)
				}
			}
			continue
		}
		events = append(events, redact.ApplyMode(ev, c.Mode, rs.Patterns))
	}
	if len(events) == 0 {
		return nil
	}
	return c.bisect(ref, events, tr.FromOffset, tr.ToOffset, cwd)
}

// currentSet returns the active RedactionSet, falling back to
// redact.DefaultSet() when SetProv is nil.
func (c *Chunker) currentSet() *redact.RedactionSet {
	if c.SetProv != nil {
		return c.SetProv.Current()
	}
	return redact.DefaultSet()
}

// bisectTarget returns the gzip byte budget; defaults to 1 MiB when
// GzipTargetBytes is zero (zero-value Chunker).
func (c *Chunker) bisectTarget() int64 {
	if c.GzipTargetBytes > 0 {
		return c.GzipTargetBytes
	}
	return 1 << 20 // 1 MiB default
}

func (c *Chunker) bisect(ref FileRef, events []redact.Event, from, to int64, cwd string) []sink.Chunk {
	if len(events) == 0 {
		return nil
	}
	if len(events) == 1 {
		return []sink.Chunk{c.build(ref, events, from, to, cwd)}
	}
	if c.gzipSize(events) <= c.bisectTarget() {
		return []sink.Chunk{c.build(ref, events, from, to, cwd)}
	}
	// Split in half by event count. PR3 first cut — line-byte ToOffset
	// alignment is coarse (we don't track per-event byte position from
	// TailResult), so each half gets from->mid and mid->to estimates.
	mid := len(events) / 2
	midOffset := from + (to-from)*int64(mid)/int64(len(events))
	left := c.bisect(ref, events[:mid], from, midOffset, cwd)
	right := c.bisect(ref, events[mid:], midOffset, to, cwd)
	return append(left, right...)
}

func (c *Chunker) gzipSize(events []redact.Event) int64 {
	raw, _ := json.Marshal(events)
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	_, _ = gw.Write(raw)
	_ = gw.Close()
	return int64(gzBuf.Len())
}

func (c *Chunker) build(ref FileRef, events []redact.Event, from, to int64, cwd string) sink.Chunk {
	return sink.Chunk{
		File:            ref.Path,
		Source:          ref.Source,
		SessionID:       ref.SessionID,
		ParentSessionID: ref.ParentSessionID,
		CWD:             cwd,
		Events:          events,
		FromOffset:      from,
		ToOffset:        to,
	}
}
