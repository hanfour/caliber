package wizard

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// TestRunEnrollWizard_WatchAll_SetsWatchAllAndSkipsSelectMulti exercises the
// non-interactive `caliber login --watch-all` shortcut end to end: it must
// skip the interactive SelectMulti prompt entirely (a FakePrompter with zero
// scripted selections would fail the test if SelectMulti were called),
// persist WatchAll=true (C1 fix: WatchAll means "no cwd filtering", NOT
// "seed IncludePaths with the transcript-file roots" — that was the bug,
// since a session's resolved cwd is never under ~/.claude/projects), and
// leave IncludePaths empty. It must also persist the overridden Mode.
func TestRunEnrollWizard_WatchAll_SetsWatchAllAndSkipsSelectMulti(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true} // only the initial "begin?" confirm fires
	deps := happyDeps(fp, nil)
	deps.ClaudeProjectsRoot = t.TempDir()
	deps.WatchAll = true
	deps.Mode = "full-body"

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.Mode != "full-body" {
		t.Errorf("Mode = %q, want full-body", cfg.Mode)
	}
	if !cfg.WatchAll {
		t.Errorf("WatchAll = false, want true")
	}
	if len(cfg.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty (WatchAll disables cwd filtering; no roots should be seeded)", cfg.IncludePaths)
	}
}

// TestRunEnrollWizard_WatchAll_NoModeOverride_KeepsDefault verifies that
// WatchAll without an explicit Mode leaves the privacy-first default
// ("metadata-only") untouched.
func TestRunEnrollWizard_WatchAll_NoModeOverride_KeepsDefault(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	deps := happyDeps(fp, nil)
	deps.ClaudeProjectsRoot = t.TempDir()
	deps.WatchAll = true

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "metadata-only" {
		t.Errorf("Mode = %q, want metadata-only default", cfg.Mode)
	}
	if !cfg.WatchAll {
		t.Errorf("WatchAll = false, want true")
	}
}
