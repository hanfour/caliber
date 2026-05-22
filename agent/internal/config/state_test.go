package config

import (
	"os"
	"path/filepath"
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

func TestLoadStateMalformedJSON(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := os.WriteFile(filepath.Join(tmp, "state.json"), []byte("{bad json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := LoadState()
	if err == nil {
		t.Fatal("expected error for malformed state JSON, got nil")
	}
}

func TestSaveStateNilFiles(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	if err := SaveState(&State{Files: nil}); err != nil {
		t.Fatalf("SaveState nil: %v", err)
	}
	loaded, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if loaded.Files == nil {
		t.Error("Files should be non-nil after SaveState+LoadState of nil")
	}
}
