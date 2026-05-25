package redact

import (
	"encoding/json"
	"testing"
	"time"
)

func TestEvent_JSONRoundTripWithPointerTokens(t *testing.T) {
	five := int64(5)
	e := Event{
		EventID:   "e-1",
		EventType: "tool_use",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		Content:   map[string]any{"name": "Read", "input": map[string]any{"path": "/x"}},
		Tokens:    &EventTokens{Input: &five},
	}
	bs, err := json.Marshal(e)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Event
	if err := json.Unmarshal(bs, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.EventID != "e-1" || got.EventType != "tool_use" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
	if got.Tokens == nil || got.Tokens.Input == nil || *got.Tokens.Input != 5 {
		t.Errorf("Tokens.Input round-trip lost: %+v", got.Tokens)
	}
}

func TestEvent_OmitemptyDropsEmptyFields(t *testing.T) {
	e := Event{
		EventID:   "e-1",
		EventType: "user",
		Timestamp: time.Date(2026, 5, 23, 10, 0, 0, 0, time.UTC),
		// ParentEventID, TurnID, Role, Content, Tokens all zero
	}
	bs, _ := json.Marshal(e)
	got := string(bs)
	for _, banned := range []string{"parent_event_id", "turn_id", "role", "content", "tokens"} {
		if contains(got, banned) {
			t.Errorf("omitempty should drop %q, got: %s", banned, got)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
