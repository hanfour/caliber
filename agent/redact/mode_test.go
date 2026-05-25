package redact

import (
	"strings"
	"testing"
	"time"
)

func sampleEvent() Event {
	five := int64(5)
	return Event{
		EventID:   "e-1",
		EventType: "assistant",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		Role:      "assistant",
		Content:   "the quick brown fox jumps over the lazy dog",
		Tokens:    &EventTokens{Output: &five},
	}
}

func TestApplyMode_MetadataOnly_StringContentBecomesLengthAndPreview(t *testing.T) {
	e := sampleEvent()
	got := ApplyMode(e, ModeMetadataOnly, nil)

	// Original unmodified (immutability)
	if e.Content != "the quick brown fox jumps over the lazy dog" {
		t.Error("ApplyMode mutated original Content")
	}

	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("Content should be a map summary, got %T: %+v", got.Content, got.Content)
	}
	if m["preview"] != "the quick brown" {
		t.Errorf("preview = %q, want %q", m["preview"], "the quick brown")
	}
	if m["length"] == nil {
		t.Error("length missing")
	}

	// Other fields passthrough
	if got.EventID != "e-1" || got.EventType != "assistant" {
		t.Errorf("got = %+v", got)
	}
	if got.Tokens == nil || got.Tokens.Output == nil || *got.Tokens.Output != 5 {
		t.Errorf("Tokens lost: %+v", got.Tokens)
	}
}

func TestApplyMode_MetadataOnly_StructuredContentBecomesToolTag(t *testing.T) {
	e := Event{
		EventID:   "e-2",
		EventType: "assistant",
		Timestamp: time.Now(),
		Content: []any{
			map[string]any{"type": "tool_use", "name": "Read", "input": map[string]any{"path": "/x"}},
		},
	}
	got := ApplyMode(e, ModeMetadataOnly, nil)
	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("got %T", got.Content)
	}
	if !strings.HasPrefix(m["preview"].(string), "<tool:") {
		t.Errorf("preview = %q, want <tool:...>", m["preview"])
	}
}

func TestApplyMode_MetadataOnly_NilContent(t *testing.T) {
	e := Event{EventID: "e-3", EventType: "system", Timestamp: time.Now()}
	got := ApplyMode(e, ModeMetadataOnly, nil)
	if got.Content != nil {
		m, ok := got.Content.(map[string]any)
		if !ok || m["preview"] != "" {
			t.Errorf("nil content should map to empty preview, got %+v", got.Content)
		}
	}
}
