package cli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

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
// at real, existing temp directories so watchAllRoots' EvalSymlinks
// canonicalization is deterministic and independent of the machine running
// the test (a dev box may or may not have a real ~/.claude/projects).
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

func TestEnroll_NonInteractive_WatchAll(t *testing.T) {
	// Use an absent path so the enroll preflight's partial-cleanup check
	// (root exists but config.toml missing) doesn't fire (mirrors
	// TestEnrollHappyPath_WritesConfigAndKeychain in enroll_test.go).
	home := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", home)
	withFakeSecurity(t, 0, "")
	claudeRoot, codexRoot := setWatchAllRootsEnv(t)

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
	if len(cfg.IncludePaths) != 2 {
		t.Fatalf("IncludePaths = %v, want exactly 2 (claude+codex roots)", cfg.IncludePaths)
	}
	wantClaude, _ := filepath.EvalSymlinks(claudeRoot)
	wantCodex, _ := filepath.EvalSymlinks(codexRoot)
	if cfg.IncludePaths[0] != filepath.Clean(wantClaude) {
		t.Errorf("IncludePaths[0] = %q, want %q", cfg.IncludePaths[0], filepath.Clean(wantClaude))
	}
	if cfg.IncludePaths[1] != filepath.Clean(wantCodex) {
		t.Errorf("IncludePaths[1] = %q, want %q", cfg.IncludePaths[1], filepath.Clean(wantCodex))
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
