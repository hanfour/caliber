package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingReturnsErrNotEnrolled(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := Load()
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestSaveThenLoadRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	c := &Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		APIBaseURL:   "https://caliber.local",
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "config.toml"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.DeviceID != c.DeviceID || got.APIBaseURL != c.APIBaseURL {
		t.Errorf("round-trip mismatch: got %+v, want %+v", got, c)
	}
	if got.IncludePaths == nil {
		t.Error("IncludePaths should be empty slice, not nil")
	}
	if len(got.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty", got.IncludePaths)
	}
}

func TestSaveIsAtomic(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := Save(&Config{DeviceID: "x"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestSaveCreatesParentDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(tmp, "nested", "deep"))
	if err := Save(&Config{DeviceID: "x"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "nested", "deep", "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.Fatal("config file was not created in nested dir")
		}
		t.Fatal(err)
	}
}
