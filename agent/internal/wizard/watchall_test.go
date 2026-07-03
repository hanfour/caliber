package wizard

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// TestRunEnrollWizard_WatchAll_SeedsBothRootsAndSkipsSelectMulti exercises the
// non-interactive `caliber login --watch-all` shortcut end to end: it must
// skip the interactive SelectMulti prompt entirely (a FakePrompter with zero
// scripted selections would fail the test if SelectMulti were called) and
// persist both canonicalized roots plus the overridden Mode.
func TestRunEnrollWizard_WatchAll_SeedsBothRootsAndSkipsSelectMulti(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	claudeRoot := t.TempDir()
	codexRoot := t.TempDir()
	t.Setenv("CALIBER_CODEX_SESSIONS", codexRoot)
	resolvedClaude, err := filepath.EvalSymlinks(claudeRoot)
	if err != nil {
		t.Fatal(err)
	}
	resolvedCodex, err := filepath.EvalSymlinks(codexRoot)
	if err != nil {
		t.Fatal(err)
	}

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true} // only the initial "begin?" confirm fires
	deps := happyDeps(fp, nil)
	deps.ClaudeProjectsRoot = claudeRoot
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
	want := []string{filepath.Clean(resolvedClaude), filepath.Clean(resolvedCodex)}
	if len(cfg.IncludePaths) != 2 || cfg.IncludePaths[0] != want[0] || cfg.IncludePaths[1] != want[1] {
		t.Fatalf("IncludePaths = %v, want %v", cfg.IncludePaths, want)
	}
}

// TestRunEnrollWizard_WatchAll_NoModeOverride_KeepsDefault verifies that
// WatchAll without an explicit Mode leaves the privacy-first default
// ("metadata-only") untouched.
func TestRunEnrollWizard_WatchAll_NoModeOverride_KeepsDefault(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	t.Setenv("CALIBER_CODEX_SESSIONS", t.TempDir())

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
}

// TestWatchAllRoots_UnresolvableRoot_FallsBackToClean covers the
// watchAllRoots best-effort branch: a root that doesn't exist yet (so
// EvalSymlinks fails) still contributes a Clean-only entry instead of being
// dropped, so `caliber login --watch-all` seeds a usable config even before
// ~/.claude/projects or ~/.codex/sessions have been created.
func TestWatchAllRoots_UnresolvableRoot_FallsBackToClean(t *testing.T) {
	missingClaude := filepath.Join(t.TempDir(), "does-not-exist", "claude-projects")
	missingCodex := filepath.Join(t.TempDir(), "does-not-exist", "codex-sessions")
	t.Setenv("CALIBER_CODEX_SESSIONS", missingCodex)

	got := watchAllRoots(missingClaude)
	want := []string{filepath.Clean(missingClaude), filepath.Clean(missingCodex)}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("watchAllRoots = %v, want %v", got, want)
	}
}

// TestWatchAllRoots_EmptyClaudeRoot_SkipsEmptyEntries covers the "root == ''"
// guard: an empty ClaudeProjectsRoot (os.UserHomeDir failed, per
// cli.claudeProjectsRoot's own fallback) must not produce a bogus "." entry.
func TestWatchAllRoots_EmptyClaudeRoot_SkipsEmptyEntries(t *testing.T) {
	codexRoot := t.TempDir()
	t.Setenv("CALIBER_CODEX_SESSIONS", codexRoot)
	resolvedCodex, err := filepath.EvalSymlinks(codexRoot)
	if err != nil {
		t.Fatal(err)
	}

	got := watchAllRoots("")
	if len(got) != 1 || got[0] != filepath.Clean(resolvedCodex) {
		t.Fatalf("watchAllRoots(\"\") = %v, want [%q]", got, filepath.Clean(resolvedCodex))
	}
}

// TestCodexSessionsRoot_DefaultsUnderHome covers codexSessionsRoot's
// no-override branch (mirrors cli.codexSessionsRoot's own test, but wizard
// duplicates the helper to avoid an import cycle with the cli package).
func TestCodexSessionsRoot_DefaultsUnderHome(t *testing.T) {
	t.Setenv("CALIBER_CODEX_SESSIONS", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir available in this environment")
	}
	want := filepath.Join(home, ".codex", "sessions")
	if got := codexSessionsRoot(); got != want {
		t.Errorf("codexSessionsRoot() = %q, want %q", got, want)
	}
}
