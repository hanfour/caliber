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
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	c := &Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		APIBaseURL:   "https://caliber.local",
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := SaveConfigInitial(c); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
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
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := SaveConfigInitial(&Config{DeviceID: "x"}); err != nil {
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
	if err := SaveConfigInitial(&Config{DeviceID: "x"}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "nested", "deep", "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.Fatal("config file was not created in nested dir")
		}
		t.Fatal(err)
	}
}

func TestLoadMalformedTOML(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	// Write invalid TOML
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte("not = [valid toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for malformed TOML, got nil")
	}
}

func TestSaveNilIncludePaths(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	// Save with nil IncludePaths — should be coerced to empty slice
	if err := SaveConfigInitial(&Config{DeviceID: "y", IncludePaths: nil}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.IncludePaths == nil {
		t.Error("IncludePaths should be non-nil after Save+Load of nil")
	}
}

func TestSaveConfigInitial_CreatesDirWhenAbsent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh-root")
	t.Setenv("CALIBER_AGENT_HOME", dir)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.toml")); err != nil {
		t.Fatalf("config.toml must exist, got %v", err)
	}
}

func TestSaveConfigInitial_SentinelPresent_Rejects(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveConfigInitial_RootExistsConfigMissing_ErrPartialUninstall(t *testing.T) {
	setupRoot(t) // root exists; no config.toml, no sentinel
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); !errors.Is(err, ErrPartialUninstall) {
		t.Fatalf("want ErrPartialUninstall, got %v", err)
	}
}

func TestSaveConfigInitial_RootIsFileNotDir_Error(t *testing.T) {
	dir := t.TempDir()
	rootPath := filepath.Join(dir, "ca-as-file")
	if err := os.WriteFile(rootPath, []byte("oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CALIBER_AGENT_HOME", rootPath)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); err == nil || errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want generic error, got %v", err)
	}
}

func TestSaveConfig_Runtime_RefusesWhenSentinelPresent(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfig(cfg); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveConfig_Runtime_RefusesWhenRootMissing(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/does-not-exist-saveconfig")
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfig(cfg); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}
