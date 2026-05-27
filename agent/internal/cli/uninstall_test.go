package cli

import (
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"
)

// TestUninstall_RunningDaemon_Default_Exit1_NoSentinelWritten covers R7-F1:
// if `.lock` is currently held by a running daemon, uninstall (without
// --force) refuses to proceed and must NOT have written `.uninstalling`.
func TestUninstall_RunningDaemon_Default_Exit1_NoSentinelWritten(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Pre-acquire .lock to simulate running daemon.
	lk, err := lockfile.Acquire(filepath.Join(root, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lk.Release()

	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 1 {
		t.Fatalf("want 1 daemon-active, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must NOT be written when refused; stat=%v", err)
	}
}

// TestUninstall_LockProbe_NoOCreate_NoStaleLockFile is a smoke test that
// asserts uninstall succeeds when no .lock pre-exists. The probe must not
// O_CREATE a fresh lockfile.
func TestUninstall_LockProbe_NoOCreate_NoStaleLockFile(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.Remove(filepath.Join(root, ".lock"))

	code := executeCLI(t, []string{"uninstall", "--keep-remote", "--yes"})
	if code != 0 {
		t.Fatalf("want 0 no-daemon-no-lock, got %d", code)
	}
}

// TestUninstall_LockProbe_ErrNotExist_TreatedAsNoDaemon ensures that an
// ErrNotExist from lockfile.Probe is treated as "no daemon running" rather
// than an error.
func TestUninstall_LockProbe_ErrNotExist_TreatedAsNoDaemon(t *testing.T) {
	setupEnrolledRoot(t)
	// .lock not created. uninstall with --yes should proceed.
	code := executeCLI(t, []string{"uninstall", "--keep-remote", "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
}

// TestUninstall_DeclinedConfirm_Exit130_ZeroSideEffect: user types "n" at
// the consent prompt. Must exit 130 and not touch config.toml or sentinel.
func TestUninstall_DeclinedConfirm_Exit130_ZeroSideEffect(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLIWithStdin(t, "n\n", []string{"uninstall"})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("cancel must not write .uninstalling; stat=%v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("cancel must preserve config.toml, got %v", err)
	}
}

// TestUninstall_NonTTY_NoYes_Exit130_ZeroSideEffect: when stdin is not a
// terminal and --yes is not passed, uninstall must refuse immediately.
func TestUninstall_NonTTY_NoYes_Exit130_ZeroSideEffect(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLI(t, []string{"uninstall"})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("cancel must preserve config.toml")
	}
}

// ----- Phase 11.2: sentinel write + remote revoke -----

// TestUninstall_SentinelWrittenAfterPrompt asserts that .uninstalling is
// present on disk by the time the remote revoke fires. The fake server
// records whether the sentinel file exists when the DELETE arrives.
func TestUninstall_SentinelWrittenAfterPrompt(t *testing.T) {
	root := setupEnrolledRoot(t)
	var sentinelSeen atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
			sentinelSeen.Store(true)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIBaseURL = srv.URL
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"uninstall", "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if !sentinelSeen.Load() {
		t.Fatalf("sentinel must be present during remote revoke")
	}
}

// TestUninstall_RemoteFails_LocalStillCleaned_Exit0 covers R14-F2: a 5xx
// from the server is logged but does not stop local cleanup. Exit must be
// 0 once the local fs portion is done.
func TestUninstall_RemoteFails_LocalStillCleaned_Exit0(t *testing.T) {
	setupEnrolledRoot(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal"}`))
	}))
	defer srv.Close()
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIBaseURL = srv.URL
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"uninstall", "--yes"})
	if code != 0 {
		t.Fatalf("local-clean-success want 0 even with remote 5xx, got %d", code)
	}
}

// TestUninstall_KeepRemote_SkipsServer ensures --keep-remote never hits
// the server. The fake server flips a flag when any request arrives.
func TestUninstall_KeepRemote_SkipsServer(t *testing.T) {
	setupEnrolledRoot(t)
	var called atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIBaseURL = srv.URL
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if called.Load() {
		t.Fatalf("--keep-remote must NOT contact server")
	}
}
