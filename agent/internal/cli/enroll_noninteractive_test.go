package cli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// enrollServer returns an httptest.Server that always replies 201 with a
// fixed enroll response, mirroring the fixture used by
// TestEnrollHappyPath_WritesConfigAndKeychain in enroll_test.go.
func enrollServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"deviceId":"d-noninteractive","key":"cda_test_secret","keyPrefix":"cda_test"}`))
	}))
}

// setWatchAllRootsEnv points CALIBER_CLAUDE_PROJECTS / CALIBER_CODEX_SESSIONS
// at real, existing temp directories. --watch-all no longer reads these into
// IncludePaths (C1 fix), but the enroll wizard's interactive-path Scan step
// still uses CALIBER_CLAUDE_PROJECTS elsewhere, so tests keep pointing it at
// a deterministic temp dir rather than a dev box's real ~/.claude/projects.
func setWatchAllRootsEnv(t *testing.T) (claudeRoot, codexRoot string) {
	t.Helper()
	base := t.TempDir()
	claudeRoot = filepath.Join(base, "claude-projects")
	codexRoot = filepath.Join(base, "codex-sessions")
	for _, d := range []string{claudeRoot, codexRoot} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}
	t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
	t.Setenv("CALIBER_CODEX_SESSIONS", codexRoot)
	return claudeRoot, codexRoot
}

// TestEnroll_NonInteractive_WatchAll is the C1 regression test at the CLI
// layer: --watch-all must persist WatchAll=true with EMPTY IncludePaths
// (not seeded with the Claude/Codex transcript roots — a session's resolved
// cwd is never under those roots, so seeding them there silently dropped
// every event; see watcher/loop.go's Tick and Config.WatchAll).
func TestEnroll_NonInteractive_WatchAll(t *testing.T) {
	// Use an absent path so the enroll preflight's partial-cleanup check
	// (root exists but config.toml missing) doesn't fire (mirrors
	// TestEnrollHappyPath_WritesConfigAndKeychain in enroll_test.go).
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	setWatchAllRootsEnv(t)

	srv := enrollServer(t)
	defer srv.Close()

	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes", "--watch-all"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mode != "full-body" {
		t.Errorf("Mode = %q, want full-body", cfg.Mode)
	}
	if !cfg.WatchAll {
		t.Errorf("WatchAll = false, want true")
	}
	if len(cfg.IncludePaths) != 0 {
		t.Fatalf("IncludePaths = %v, want empty (WatchAll disables cwd filtering entirely)", cfg.IncludePaths)
	}
}

func TestEnroll_NonInteractive_ExplicitMode(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	setWatchAllRootsEnv(t)

	srv := enrollServer(t)
	defer srv.Close()

	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes", "--watch-all", "--mode", "redacted-body"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mode != "redacted-body" {
		t.Errorf("Mode = %q, want redacted-body (explicit --mode should win over --yes default)", cfg.Mode)
	}
}

// #6: --backfill-days defaults to 90 when unset, threaded end-to-end from
// the cobra flag through wizard.Deps into the persisted config.
func TestEnroll_BackfillDays_DefaultsTo90(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	setWatchAllRootsEnv(t)

	srv := enrollServer(t)
	defer srv.Close()

	before := time.Now().AddDate(0, 0, -90)
	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes", "--watch-all"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}
	after := time.Now().AddDate(0, 0, -90)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BackfillCutoff.Before(before.Add(-time.Second)) || cfg.BackfillCutoff.After(after.Add(time.Second)) {
		t.Fatalf("BackfillCutoff = %v, want within [%v, %v] (default 90 days)", cfg.BackfillCutoff, before, after)
	}
}

// M3: --backfill-days 0 means "from now" — the cutoff must be pinned to
// (approximately) enroll time so historical sessions are NOT uploaded, not
// left at the zero Time value (which would disable the filter and upload
// the caller's entire history — the M3 privacy footgun).
func TestEnroll_BackfillDaysZero_MeansFromNow(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	setWatchAllRootsEnv(t)

	srv := enrollServer(t)
	defer srv.Close()

	before := time.Now()
	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes", "--watch-all", "--backfill-days", "0"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}
	after := time.Now()

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BackfillCutoff.IsZero() {
		t.Fatalf("BackfillCutoff is zero, want ~now (--backfill-days 0 means from-now, not entire-history)")
	}
	if cfg.BackfillCutoff.Before(before.Add(-time.Second)) || cfg.BackfillCutoff.After(after.Add(time.Second)) {
		t.Fatalf("BackfillCutoff = %v, want within [%v, %v] (from-now)", cfg.BackfillCutoff, before, after)
	}
}

// --backfill-days negative disables the filter entirely (entire history
// uploaded) — BackfillCutoff stays at its zero Time value.
func TestEnroll_BackfillDaysNegative_DisablesCutoff(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	setWatchAllRootsEnv(t)

	srv := enrollServer(t)
	defer srv.Close()

	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes", "--watch-all", "--backfill-days", "-1"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.BackfillCutoff.IsZero() {
		t.Fatalf("BackfillCutoff = %v, want zero (--backfill-days negative disables filter)", cfg.BackfillCutoff)
	}
}

func TestEnroll_Yes_WithoutWatchAll_KeepsInteractiveDefaultEmptyPaths(t *testing.T) {
	// --yes alone (no --watch-all) should still drive the AutoPrompter through
	// the interactive SelectMulti path, which picks every option including
	// index 0 ("None"), collapsing the selection back to empty include_paths.
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")

	srv := enrollServer(t)
	defer srv.Close()

	code := executeCLI(t, []string{"enroll", "test-token", "--api-base-url", srv.URL, "--insecure", "--yes"})
	if code != 0 {
		t.Fatalf("enroll exit = %d, want 0", code)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mode != "full-body" {
		t.Errorf("Mode = %q, want full-body (default when --yes set)", cfg.Mode)
	}
	if len(cfg.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty (no --watch-all)", cfg.IncludePaths)
	}
}
