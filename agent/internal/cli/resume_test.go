package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// TestResume_RemovesSentinel: happy path. Paused sentinel exists, `resume`
// removes it and exits 0.
func TestResume_RemovesSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"resume"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must be removed, stat err=%v", err)
	}
}

// TestResume_NotPaused_NoOp: with no paused file present, resume is a no-op
// that prints "not paused" and exits 0.
func TestResume_NotPaused_NoOp(t *testing.T) {
	setupEnrolledRoot(t)
	code := executeCLI(t, []string{"resume"})
	if code != 0 {
		t.Fatalf("want 0 idempotent, got %d", code)
	}
}
