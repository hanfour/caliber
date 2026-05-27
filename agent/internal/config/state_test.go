package config

import (
	"errors"
	"io/fs"
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
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
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
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
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

func TestSaveState_RefusesWriteWhenRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestSaveState_RefusesWriteWhenSentinelExists(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveState_RefusesWriteWhenConfigTomlMissing(t *testing.T) {
	setupRoot(t) // root exists, no config.toml
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestSaveState_DoesNotMkdirAll(t *testing.T) {
	root := setupRoot(t)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	_ = SaveState(&State{Files: map[string]FileWatermark{}})
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("SaveState must NOT recreate root, got stat err=%v", err)
	}
}

func TestSaveState_HappyPath_AllPrechecksMet(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "state.json")); err != nil {
		t.Fatalf("state.json must exist, got %v", err)
	}
}
