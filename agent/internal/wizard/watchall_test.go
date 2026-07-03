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

// TestWatchAllRoots_UnresolvableRoot_ResolvesNearestExistingAncestor covers
// the watchAllRoots best-effort branch: a root that doesn't exist yet (so
// EvalSymlinks fails on the full path) must still canonicalize through its
// nearest existing ancestor — NOT fall back to a raw Clean-only path — so the
// stored entry string-matches what loop.go's allowed() computes at match
// time (EvalSymlinks(cwd)) when an ancestor (e.g. HOME) is itself reached via
// a symlink. Both roots must still be present (dropping codex would be worse
// — it wouldn't be watched until first use).
//
// This exercises a real symlink in the wild: on macOS, t.TempDir() lives
// under /var/folders/..., and /var is itself a symlink to /private/var, so
// EvalSymlinks(tmp) != tmp — the exact class of bug the reviewer flagged.
func TestWatchAllRoots_UnresolvableRoot_ResolvesNearestExistingAncestor(t *testing.T) {
	tmp := t.TempDir()
	missingClaude := filepath.Join(tmp, "does-not-exist", "claude-projects")
	missingCodex := filepath.Join(tmp, "does-not-exist", "codex-sessions")
	t.Setenv("CALIBER_CODEX_SESSIONS", missingCodex)

	resolvedTmp, err := filepath.EvalSymlinks(tmp)
	if err != nil {
		t.Fatal(err)
	}

	got := watchAllRoots(missingClaude)
	want := []string{
		filepath.Join(resolvedTmp, "does-not-exist", "claude-projects"),
		filepath.Join(resolvedTmp, "does-not-exist", "codex-sessions"),
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("watchAllRoots = %v, want %v", got, want)
	}
}

// TestWatchAllRoots_SymlinkedHome_ResolvesToRealHome is the scenario the
// reviewer called out directly: HOME (or CALIBER_AGENT-adjacent dirs) is a
// symlink, and the leaf dir (~/.codex/sessions) doesn't exist yet on a fresh
// machine, so EvalSymlinks on the full path fails outright. The stored root
// must still resolve through the symlinked HOME to the real directory,
// matching what allowed() computes for a cwd reached via the same symlink.
func TestWatchAllRoots_SymlinkedHome_ResolvesToRealHome(t *testing.T) {
	realHome := t.TempDir()
	symHome := filepath.Join(t.TempDir(), "home-link")
	if err := os.Symlink(realHome, symHome); err != nil {
		t.Skipf("symlink not supported in this environment: %v", err)
	}
	t.Setenv("HOME", symHome)
	t.Setenv("CALIBER_CODEX_SESSIONS", "") // force default (home-relative) codex root

	claudeRoot := filepath.Join(symHome, ".claude", "projects") // neither leaf exists yet

	// realHome (from t.TempDir()) can itself sit behind a platform symlink
	// (e.g. macOS /var -> /private/var); resolve it so this test isolates
	// the "HOME is a symlink" scenario from that unrelated artifact.
	resolvedRealHome, err := filepath.EvalSymlinks(realHome)
	if err != nil {
		t.Fatal(err)
	}

	got := watchAllRoots(claudeRoot)
	want := []string{
		filepath.Join(resolvedRealHome, ".claude", "projects"),
		filepath.Join(resolvedRealHome, ".codex", "sessions"),
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("watchAllRoots = %v, want %v (resolved through symlinked HOME)", got, want)
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
