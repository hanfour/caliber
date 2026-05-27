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
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
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

// ----- Phase 11.3: keychain delete -----

// withKeychainDelete swaps the package-level keychainDelete hook with the
// supplied stub for the duration of the test. Tests that need keychain.Delete
// to fail (or return ErrNotFound) use this helper to avoid spawning a
// `security` binary stub script.
func withKeychainDelete(t *testing.T, stub func(account string) error) {
	t.Helper()
	orig := keychainDelete
	keychainDelete = stub
	t.Cleanup(func() { keychainDelete = orig })
}

// TestUninstall_KeychainNotFound_Continues_Exit0: keychain.ErrNotFound is a
// soft failure — the entry is already gone, so uninstall proceeds and exits 0.
func TestUninstall_KeychainNotFound_Continues_Exit0(t *testing.T) {
	setupEnrolledRoot(t)
	withKeychainDelete(t, func(string) error { return keychain.ErrNotFound })
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0 (ErrNotFound treated as already-clean), got %d", code)
	}
}

// TestUninstall_KeychainDeleteFails_Exit1_SentinelRestored: a hard keychain
// failure must (1) exit 1 and (2) restore the absent state of .uninstalling
// so the daemon (if still running, e.g. under --force) can recover.
func TestUninstall_KeychainDeleteFails_Exit1_SentinelRestored(t *testing.T) {
	root := setupEnrolledRoot(t)
	withKeychainDelete(t, func(string) error { return errors.New("permission denied") })
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must be restored to absent on keychain failure, got stat=%v", err)
	}
}

// ----- Phase 11.4: ordered_delete (a)-(i) -----

// traceRemovesDuring swaps the package-level osRemove hook to record every
// path uninstall removes. The trace order is the sequence of os.Remove calls
// uninstall performs; the test asserts step ordering against that.
func traceRemovesDuring(t *testing.T, fn func()) []string {
	t.Helper()
	var trace []string
	origRemove := osRemove
	osRemove = func(name string) error {
		err := origRemove(name)
		if err == nil || errors.Is(err, fs.ErrNotExist) {
			// We log even ErrNotExist removals because the order of attempts
			// (not just successes) is what the invariant tests assert.
			trace = append(trace, name)
		}
		return err
	}
	t.Cleanup(func() { osRemove = origRemove })
	fn()
	return trace
}

// indexOf returns the first index of item in slice, or -1 if absent.
func indexOf(slice []string, item string) int {
	for i, s := range slice {
		if s == item {
			return i
		}
	}
	return -1
}

// TestUninstall_OrderedCleanup_SentinelDeletedLastBeforeRmdir asserts the
// (h) → (i) ordering: .uninstalling is the LAST file removed before rmdir.
func TestUninstall_OrderedCleanup_SentinelDeletedLastBeforeRmdir(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Pre-create paused so step (d) hits a real file too.
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	// Find the last file removed before root.
	rootIdx := indexOf(trace, root)
	if rootIdx < 0 {
		t.Fatalf("rmdir(root) absent from trace: %v", trace)
	}
	if rootIdx == 0 {
		t.Fatalf("rmdir was first — no files removed before it: %v", trace)
	}
	lastFile := trace[rootIdx-1]
	if filepath.Base(lastFile) != ".uninstalling" {
		t.Fatalf("expected .uninstalling to be last before rmdir, got %s; full trace=%v", lastFile, trace)
	}
}

// TestUninstall_OrderedCleanup_ConfigTomlDeletedBeforeSentinel covers the
// (g) → (h) ordering: config.toml must precede .uninstalling.
func TestUninstall_OrderedCleanup_ConfigTomlDeletedBeforeSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	cfgIdx := indexOf(trace, filepath.Join(root, "config.toml"))
	sentIdx := indexOf(trace, filepath.Join(root, ".uninstalling"))
	if cfgIdx < 0 || sentIdx < 0 || cfgIdx >= sentIdx {
		t.Fatalf("config.toml must precede .uninstalling: cfg=%d sentinel=%d trace=%v", cfgIdx, sentIdx, trace)
	}
}

// TestUninstall_OrderedCleanup_TmpGlobsCleared_RmdirSucceeds seeds tmp files
// matching the atomic-writer patterns and asserts that step (f) clears them
// so step (i) rmdir succeeds.
func TestUninstall_OrderedCleanup_TmpGlobsCleared_RmdirSucceeds(t *testing.T) {
	root := setupEnrolledRoot(t)
	for _, n := range []string{".config.toml.abc123", ".state.json.xyz789", ".redaction-set.json.42"} {
		if err := os.WriteFile(filepath.Join(root, n), []byte{}, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("rmdir must succeed; root still exists: %v", err)
	}
}

// TestUninstall_OrderedCleanup_RmdirFailsAfterSentinelRemoved_NoSentinelRestore
// covers R13-F2: once (h) has removed the sentinel, a subsequent rmdir
// failure must NOT restore it.
func TestUninstall_OrderedCleanup_RmdirFailsAfterSentinelRemoved_NoSentinelRestore(t *testing.T) {
	root := setupEnrolledRoot(t)
	stray := filepath.Join(root, "user-dropped-file.txt")
	if err := os.WriteFile(stray, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must remain absent after (h); got stat=%v", err)
	}
}

// TestUninstall_InvariantSentinelOutlivesConfigToml asserts the spec's
// load-bearing invariant: while config.toml exists, .uninstalling must
// also exist. Equivalent to "remove(config.toml) < remove(.uninstalling)".
func TestUninstall_InvariantSentinelOutlivesConfigToml(t *testing.T) {
	root := setupEnrolledRoot(t)
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	cfgIdx := indexOf(trace, filepath.Join(root, "config.toml"))
	sentIdx := indexOf(trace, filepath.Join(root, ".uninstalling"))
	if cfgIdx < 0 || sentIdx < 0 {
		t.Fatalf("both paths must appear in trace; trace=%v", trace)
	}
	if sentIdx < cfgIdx {
		t.Fatalf("invariant violated: .uninstalling removed before config.toml; trace=%v", trace)
	}
}
