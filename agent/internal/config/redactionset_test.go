package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

func TestLoadRedactionSet_MissingReturnsErrNoRedactionSet(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := LoadRedactionSet()
	if !errors.Is(err, redact.ErrNoRedactionSet) {
		t.Errorf("err = %v, want ErrNoRedactionSet", err)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	tmp := setupRoot(t)
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	orig := &redact.RedactionSet{
		Patterns: []redact.Pattern{
			{Name: "test", RegexSrc: `[0-9]+`, Replacement: "#"},
		},
		Version:    "v-test",
		FetchedAt:  time.Date(2026, 5, 23, 0, 0, 0, 0, time.UTC),
		TTLSeconds: 3600,
	}
	if err := SaveRedactionSet(orig); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "redaction-set.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := LoadRedactionSet()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Version != "v-test" || got.TTLSeconds != 3600 {
		t.Errorf("got = %+v", got)
	}
	if len(got.Patterns) != 1 || got.Patterns[0].RegexSrc != `[0-9]+` {
		t.Errorf("Patterns = %+v", got.Patterns)
	}
}

func TestSaveIsAtomic_NoLeftoverTmp(t *testing.T) {
	tmp := setupRoot(t)
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveRedactionSet(&redact.RedactionSet{Patterns: nil, Version: "v", TTLSeconds: 1}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(tmp)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestRedactionSetPath_HonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/x")
	if got := RedactionSetPath(); got != "/x/redaction-set.json" {
		t.Errorf("got %q", got)
	}
}

func TestSaveRedactionSet_RefusesWhenRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/does-not-exist-saveredact")
	if err := SaveRedactionSet(&redact.RedactionSet{}); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestSaveRedactionSet_RefusesWhenSentinelPresent(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	if err := SaveRedactionSet(&redact.RedactionSet{}); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveRedactionSet_HappyPath(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	if err := SaveRedactionSet(&redact.RedactionSet{Version: "v"}); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}
