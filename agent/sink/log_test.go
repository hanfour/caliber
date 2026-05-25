package sink

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

func fixedNow(s string) func() time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return func() time.Time { return t }
}

func TestLogSink_Happy_EmitsMetadataLine(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	s.Now = fixedNow("2026-05-22T10:00:00Z")

	err := s.SendChunk(context.Background(), Chunk{
		File:      "/Users/h/.claude/projects/-Users-h-proj/sess.jsonl",
		Source:    "claude",
		SessionID: "sess-1",
		CWD:       "/Users/h/proj",
		Events: []redact.Event{
			{EventID: "e-1", EventType: "user"},
			{EventID: "e-2", EventType: "assistant"},
			{EventID: "e-3", EventType: "tool_use"},
		},
		FromOffset: 100,
		ToOffset:   300,
	})
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	got := buf.String()
	for _, want := range []string{
		"2026-05-22T10:00:00Z",
		"[chunk]",
		"source=claude",
		"file=/Users/h/.claude/projects/-Users-h-proj/sess.jsonl",
		"session=sess-1",
		"cwd=/Users/h/proj",
		"events=3",
		"bytes=100-300",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("log missing %q in %q", want, got)
		}
	}
}

func TestLogSink_Privacy_NoEventContentInOutput(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	const canary = "my-fake-cda_test_should_never_appear"
	err := s.SendChunk(context.Background(), Chunk{
		Events: []redact.Event{
			{EventID: canary, EventType: "user", Content: canary},
			{EventID: "e-2", EventType: "user"},
		},
	})
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	if strings.Contains(buf.String(), canary) {
		t.Errorf("privacy guard violated: event content %q leaked to log: %q", canary, buf.String())
	}
}

type failingWriter struct{ err error }

func (w *failingWriter) Write(_ []byte) (int, error) { return 0, w.err }

func TestLogSink_FailingWriter_ReturnsWrappedError(t *testing.T) {
	w := &failingWriter{err: errors.New("disk full")}
	s := NewLogSink(w)
	err := s.SendChunk(context.Background(), Chunk{
		File:     "/x",
		Events:   []redact.Event{{EventID: "a", EventType: "user"}},
		ToOffset: 10,
	})
	if err == nil {
		t.Fatal("expected non-nil error from failing writer")
	}
	if !strings.Contains(err.Error(), "disk full") {
		t.Errorf("error should wrap underlying cause, got: %v", err)
	}
}

func TestLogSink_NowInjection(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	s.Now = fixedNow("2026-01-15T03:30:45Z")
	_ = s.SendChunk(context.Background(), Chunk{})
	if !strings.HasPrefix(buf.String(), "2026-01-15T03:30:45Z ") {
		t.Errorf("timestamp wrong: %q", buf.String())
	}
}
