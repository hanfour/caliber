package cli

import (
	"path/filepath"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestRemovePath_HappyPath(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	// Pre-populate with the canonical form so remove-path's normalisation
	// matches the on-disk entry.
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	canonical = filepath.Clean(canonical)
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{canonical}
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"remove-path", target})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	cfg2, _ := config.Load()
	if len(cfg2.IncludePaths) != 0 {
		t.Fatalf("want [], got %v", cfg2.IncludePaths)
	}
}

func TestRemovePath_NotInList_NoOp(t *testing.T) {
	setupEnrolledRoot(t)
	// Clear seed so the test exercises the "not in list" branch deterministically.
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{}
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"remove-path", t.TempDir()})
	if code != 0 {
		t.Fatalf("want 0 noop, got %d", code)
	}
}

func TestRemovePath_BrokenSymlink_StillRemoves(t *testing.T) {
	setupEnrolledRoot(t)
	// Pre-populate with a path that no longer exists. EvalSymlinks will
	// fail; remove-path must fall back to filepath.Clean(raw) and match
	// the raw stored entry.
	gone := filepath.Join(t.TempDir(), "deleted")
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{gone}
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"remove-path", gone})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	cfg2, _ := config.Load()
	for _, p := range cfg2.IncludePaths {
		if p == gone {
			t.Fatalf("broken-symlink entry must be removed, got %v", cfg2.IncludePaths)
		}
	}
}
