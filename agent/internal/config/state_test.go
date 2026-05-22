package config

import (
	"testing"
	"time"
)

func TestLoadStateMissingReturnsEmpty(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	s, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState on empty: %v", err)
	}
	if s == nil || s.Files == nil {
		t.Fatal("LoadState should return non-nil State with non-nil Files map")
	}
	if len(s.Files) != 0 {
		t.Fatalf("Files = %v, want empty", s.Files)
	}
}

func TestStateRoundTrip(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	now := time.Now().UTC().Truncate(time.Second)
	s := &State{Files: map[string]FileWatermark{
		"/path/to/a.jsonl": {Offset: 42, LastSync: now},
	}}
	if err := SaveState(s); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	loaded, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if got := loaded.Files["/path/to/a.jsonl"]; got.Offset != 42 || !got.LastSync.Equal(now) {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}
