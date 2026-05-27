package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// TestPause_TouchesSentinel: happy path. With a valid enrolled root and no
// .uninstalling, `pause` exits 0 and creates the paused sentinel.
func TestPause_TouchesSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLI(t, []string{"pause"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); err != nil {
		t.Fatalf("paused must exist, got %v", err)
	}
}

// TestPause_Idempotent: re-pausing when already paused is a no-op pass.
func TestPause_Idempotent(t *testing.T) {
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"pause"})
	if code != 0 {
		t.Fatalf("idempotent want 0, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); err != nil {
		t.Fatalf("paused must still exist after re-pause, got %v", err)
	}
}

// TestPause_NoConfigDir_Exit1: when the root directory is missing entirely
// pause must NOT MkdirAll and must exit 1 with a not-enrolled error.
func TestPause_NoConfigDir_Exit1(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("pause must NOT create root when not enrolled, stat err=%v", err)
	}
}

// TestPause_ConfigTomlMissing_Exit1_NoPausedFileCreated: root exists but
// config.toml is missing (partial-uninstall). Must refuse with exit 1 and
// must NOT create paused.
func TestPause_ConfigTomlMissing_Exit1_NoPausedFileCreated(t *testing.T) {
	root := setupRoot(t) // root exists, no config.toml
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must not be created when not enrolled, stat err=%v", err)
	}
}

// TestPause_UninstallInProgress_Exit1_NoPausedFileCreated: R9-F1 fail-closed.
// If `.uninstalling` exists, pause must refuse and must NOT create paused
// (don't introduce a new sentinel during the cleanup window).
func TestPause_UninstallInProgress_Exit1_NoPausedFileCreated(t *testing.T) {
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must not be created during uninstall, stat err=%v", err)
	}
}
