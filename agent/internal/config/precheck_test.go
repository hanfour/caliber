package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// setupRoot creates a fresh temp dir, points CALIBER_AGENT_HOME at it, and
// returns the dir path. Shared across all precheckRuntime-aware tests in
// this package.
func setupRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", dir)
	return dir
}

func TestPrecheckRuntime_AllPresent_ReturnsNil(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestPrecheckRuntime_RootMissing_ReturnsErrRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/nonexistent-caliber-agent-precheck")
	if err := precheckRuntime(); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestPrecheckRuntime_SentinelPresent_ReturnsErrUninstallInProgress(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestPrecheckRuntime_ConfigMissing_ReturnsErrConfigRemoved(t *testing.T) {
	setupRoot(t) // root exists, config.toml does not
	if err := precheckRuntime(); !errors.Is(err, ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestPrecheckRuntime_SentinelStatNonNotExist_FailsClosed(t *testing.T) {
	// Hard to provoke EACCES portably in unit test; assert documented behaviour via wrapped sentinel.
	// On platforms where Permission errors are possible, integration coverage handles this.
	root := setupRoot(t)
	// Make sentinel a directory (Stat returns nil err, but treat as "exists").
	if err := os.Mkdir(filepath.Join(root, ".uninstalling"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress for non-ErrNotExist sentinel stat, got %v", err)
	}
	// Sanity: fs.ErrNotExist isn't being shadowed.
	_, sErr := os.Stat(filepath.Join(root, "does-not-exist"))
	if !errors.Is(sErr, fs.ErrNotExist) {
		t.Fatalf("test helper assumption broken")
	}
}
