package watcher

import (
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/sink"
)

func TestChunker_OneChunkPerNonEmptyTailResult(t *testing.T) {
	c := &Chunker{}
	ref := FileRef{
		Path:      "/x.jsonl",
		Source:    "claude",
		SessionID: "s1",
	}
	tr := TailResult{
		Events:     []string{`{"a":1}`, `{"b":2}`},
		FromOffset: 0,
		ToOffset:   16,
	}
	chunks := c.Split(ref, tr, "/Users/h/proj")
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1", len(chunks))
	}
	got := chunks[0]
	want := sink.Chunk{
		File:       "/x.jsonl",
		Source:     "claude",
		SessionID:  "s1",
		CWD:        "/Users/h/proj",
		Events:     []string{`{"a":1}`, `{"b":2}`},
		FromOffset: 0,
		ToOffset:   16,
	}
	if got.File != want.File || got.Source != want.Source || got.SessionID != want.SessionID ||
		got.CWD != want.CWD || got.FromOffset != want.FromOffset || got.ToOffset != want.ToOffset {
		t.Errorf("got = %+v, want %+v", got, want)
	}
	if len(got.Events) != 2 || got.Events[0] != `{"a":1}` || got.Events[1] != `{"b":2}` {
		t.Errorf("Events mismatch: %v", got.Events)
	}
}

func TestChunker_EmptyTailResult_ZeroChunks(t *testing.T) {
	c := &Chunker{}
	tr := TailResult{FromOffset: 100, ToOffset: 100}
	chunks := c.Split(FileRef{}, tr, "")
	if len(chunks) != 0 {
		t.Errorf("got %d chunks, want 0", len(chunks))
	}
}
