package watcher

import (
	"strings"
	"sync"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/redact"
	"github.com/hanfour/ai-dev-eval/agent/redact/parser"
)

type capturedLogger struct {
	mu    sync.Mutex
	lines []string
}

func (l *capturedLogger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, format)
}

type staticProvider struct{ s *redact.RedactionSet }

func (p *staticProvider) Current() *redact.RedactionSet { return p.s }

// stubParser parses fixed-shape lines: "skip" returns ErrSkipLine;
// "bad" returns a non-skip error; anything else produces an Event
// where Content == the input line.
func stubParser(_ string, line string) (redact.Event, error) {
	switch line {
	case "skip":
		return redact.Event{}, parser.ErrSkipLine
	case "bad":
		return redact.Event{}, jsonError("not json")
	}
	return redact.Event{EventID: line, EventType: "test", Content: line}, nil
}

type jsonError string

func (e jsonError) Error() string { return string(e) }

func TestChunker_DispatchesParser_AndAppliesMode(t *testing.T) {
	rs := redact.DefaultSet()
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeMetadataOnly,
		SetProv:         &staticProvider{s: rs},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	tr := TailResult{
		Events:     []string{"a", "b", "c"},
		FromOffset: 0,
		ToOffset:   12,
	}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s1"}, tr, "/Users/h/proj")
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1", len(chunks))
	}
	got := chunks[0]
	if len(got.Events) != 3 {
		t.Errorf("len(Events) = %d, want 3", len(got.Events))
	}
	// metadata-only mode collapses Content into {length, preview} map
	for _, ev := range got.Events {
		m, ok := ev.Content.(map[string]any)
		if !ok {
			t.Errorf("Content not a summary map: %T", ev.Content)
			continue
		}
		if _, ok := m["length"]; !ok {
			t.Errorf("summary missing length: %v", m)
		}
	}
}

func TestChunker_SkipLineSilentlyIgnored(t *testing.T) {
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	tr := TailResult{Events: []string{"a", "skip", "b"}, ToOffset: 9}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/Users/h/proj")
	if len(chunks) != 1 || len(chunks[0].Events) != 2 {
		t.Fatalf("expected 1 chunk with 2 events (skipped one), got %d chunks", len(chunks))
	}
}

func TestChunker_ParseErrorLogsAndSkips(t *testing.T) {
	log := &capturedLogger{}
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             log,
	}
	tr := TailResult{Events: []string{"a", "bad", "b"}, ToOffset: 9}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/Users/h/proj")
	if len(chunks) != 1 || len(chunks[0].Events) != 2 {
		t.Errorf("expected 2 events, got %d", len(chunks[0].Events))
	}
	found := false
	for _, ln := range log.lines {
		if strings.Contains(ln, "parse failed") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected [warn] parse failed log; got %v", log.lines)
	}
}

func TestChunker_EmptyTailResult_ZeroChunks(t *testing.T) {
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 1 << 20,
		Log:             &capturedLogger{},
	}
	chunks := c.Split(FileRef{Source: "claude"}, TailResult{}, "/cwd")
	if len(chunks) != 0 {
		t.Errorf("got %d chunks, want 0", len(chunks))
	}
}

func TestChunker_LargeBodySplitsAtEventBoundary(t *testing.T) {
	// Force the bisect path with a tiny gzip budget.
	c := &Chunker{
		Parser:          stubParser,
		Mode:            redact.ModeRedactedBody,
		SetProv:         &staticProvider{s: redact.DefaultSet()},
		GzipTargetBytes: 32,
		Log:             &capturedLogger{},
	}
	tr := TailResult{
		Events:     []string{"a", "b", "c", "d"},
		FromOffset: 0,
		ToOffset:   16,
	}
	chunks := c.Split(FileRef{Path: "/x.jsonl", Source: "claude", SessionID: "s"}, tr, "/cwd")
	if len(chunks) < 2 {
		t.Errorf("expected >= 2 chunks under tight size budget, got %d", len(chunks))
	}
	total := 0
	for _, ch := range chunks {
		total += len(ch.Events)
	}
	if total != 4 {
		t.Errorf("total events = %d, want 4", total)
	}
}
