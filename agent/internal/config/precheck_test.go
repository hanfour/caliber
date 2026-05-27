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

func TestPrecheckRuntime_SentinelExistsAsDirectory_ReturnsErrUninstallInProgress(t *testing.T) {
	// When the sentinel exists as a directory (or as any path os.Stat can read),
	// the "err == nil" branch of precheckRuntime fires and returns ErrUninstallInProgress
	// directly — we are NOT exercising the wrapped fail-closed branch here.
	// Provoking the wrapped branch (e.g. EACCES on sentinel stat) is not portable across
	// macOS/Linux/Windows; integration tests can cover that path if needed.
	root := setupRoot(t)
	if err := os.Mkdir(filepath.Join(root, ".uninstalling"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
	// Sanity: fs.ErrNotExist isn't being shadowed by the test platform.
	_, sErr := os.Stat(filepath.Join(root, "does-not-exist"))
	if !errors.Is(sErr, fs.ErrNotExist) {
		t.Fatalf("test helper assumption broken")
	}
}
