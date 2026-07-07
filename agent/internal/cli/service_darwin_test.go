//go:build darwin

package cli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestWriteLaunchAgentPlist exercises the pure plist-writing path (no
// launchctl involved) with HOME redirected to a temp dir, so it cannot
// touch the real machine's ~/Library/LaunchAgents.
func TestWriteLaunchAgentPlist(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	path, err := writeLaunchAgentPlist("/usr/local/bin/caliber-agent", "/tmp/agent.log")
	if err != nil {
		t.Fatalf("writeLaunchAgentPlist: %v", err)
	}
	wantPath := filepath.Join(tmp, "Library", "LaunchAgents", "tw.caliber.agent.plist")
	if path != wantPath {
		t.Fatalf("path = %q, want %q", path, wantPath)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(body), "/usr/local/bin/caliber-agent") {
		t.Error("written plist missing exec path")
	}

	// Re-running (as install-service would on a re-install) must overwrite
	// cleanly, not error.
	if _, err := writeLaunchAgentPlist("/usr/local/bin/caliber-agent", "/tmp/agent.log"); err != nil {
		t.Fatalf("second writeLaunchAgentPlist: %v", err)
	}
}

// TestRemoveLaunchAgentPlist verifies both the normal-delete path and the
// idempotent not-exist path (uninstall-service must succeed even if the
// plist was never installed or was already removed).
func TestRemoveLaunchAgentPlist(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "tw.caliber.agent.plist")

	if err := os.WriteFile(path, []byte("stub"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := removeLaunchAgentPlist(path); err != nil {
		t.Fatalf("removeLaunchAgentPlist (existing): %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file still present after removeLaunchAgentPlist: %v", err)
	}

	// Idempotent: removing an already-gone plist must not error.
	if err := removeLaunchAgentPlist(path); err != nil {
		t.Fatalf("removeLaunchAgentPlist (already gone): %v", err)
	}
}

// TestWriteLaunchAgentPlist_MkdirFails covers the error branch: if the
// LaunchAgents parent path is blocked by a regular file, MkdirAll fails and
// writeLaunchAgentPlist must surface that instead of panicking or silently
// succeeding.
func TestWriteLaunchAgentPlist_MkdirFails(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	// Put a regular file where the "Library" directory needs to go, so
	// MkdirAll(.../Library/LaunchAgents) fails with ENOTDIR.
	if err := os.WriteFile(filepath.Join(tmp, "Library"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed blocking file: %v", err)
	}

	if _, err := writeLaunchAgentPlist("/usr/local/bin/caliber-agent", "/tmp/agent.log"); err == nil {
		t.Fatal("expected error when LaunchAgents parent cannot be created")
	}
}

// TestInstallServiceCmd_WritesPlistAndLoads drives the full
// install-service RunE with a fake launchAgentLoader so the real launchctl
// is never invoked, verifying the plist lands on disk and the loader
// receives the same path install-service reports.
func TestInstallServiceCmd_WritesPlistAndLoads(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	var loadedPath string
	origLoader := launchAgentLoader
	launchAgentLoader = func(path string) error {
		loadedPath = path
		return nil
	}
	// Inject a running PID so the #253 post-bootstrap verification passes
	// deterministically instead of shelling out to the real launchctl
	// (whose result depends on whatever job the dev machine has loaded).
	origPID := launchAgentPID
	launchAgentPID = func(string) (int, bool) { return 1234, true }
	t.Cleanup(func() {
		launchAgentLoader = origLoader
		launchAgentPID = origPID
	})

	cmd := newInstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatalf("RunE: %v", err)
	}

	wantPath := filepath.Join(tmp, "Library", "LaunchAgents", "tw.caliber.agent.plist")
	if loadedPath != wantPath {
		t.Fatalf("loadedPath = %q, want %q", loadedPath, wantPath)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	if !strings.Contains(buf.String(), "installed") {
		t.Errorf("expected confirmation output, got %q", buf.String())
	}
}

// TestInstallServiceCmd_FailsWhenServiceNeverRuns is the #253 regression:
// bootstrap can succeed while the job silently exits 0 without ever holding
// a PID (KeepAlive{SuccessfulExit:false} then never retries). install-service
// must detect the never-running state and fail LOUDLY with a kickstart
// remediation, instead of printing "installed" over a dead service.
func TestInstallServiceCmd_FailsWhenServiceNeverRuns(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	origLoader := launchAgentLoader
	launchAgentLoader = func(string) error { return nil }
	origPID := launchAgentPID
	launchAgentPID = func(string) (int, bool) { return 0, false } // never running
	origAtt := launchAgentPollAttempts
	launchAgentPollAttempts = 2
	origDelay := launchAgentPollDelay
	launchAgentPollDelay = time.Millisecond
	t.Cleanup(func() {
		launchAgentLoader = origLoader
		launchAgentPID = origPID
		launchAgentPollAttempts = origAtt
		launchAgentPollDelay = origDelay
	})

	cmd := newInstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	err := cmd.RunE(cmd, nil)
	if err == nil {
		t.Fatal("expected error when the launchd job never reaches a running state")
	}
	if !strings.Contains(err.Error(), "kickstart") {
		t.Errorf("error must carry a kickstart remediation, got: %v", err)
	}
}

// TestInstallServiceCmd_ConfirmsPIDWhenRunning verifies the happy path
// reports the live PID once the job is confirmed running.
func TestInstallServiceCmd_ConfirmsPIDWhenRunning(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	origLoader := launchAgentLoader
	launchAgentLoader = func(string) error { return nil }
	origPID := launchAgentPID
	launchAgentPID = func(string) (int, bool) { return 4321, true }
	t.Cleanup(func() {
		launchAgentLoader = origLoader
		launchAgentPID = origPID
	})

	cmd := newInstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatalf("RunE: %v", err)
	}
	if !strings.Contains(buf.String(), "installed") || !strings.Contains(buf.String(), "4321") {
		t.Errorf("expected running confirmation with pid, got %q", buf.String())
	}
}

// TestInstallServiceCmd_LoadErrorPropagates verifies a launchctl bootstrap
// failure (simulated via the fake loader) surfaces as a command error
// rather than being swallowed.
func TestInstallServiceCmd_LoadErrorPropagates(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	origLoader := launchAgentLoader
	launchAgentLoader = func(string) error { return errors.New("bootstrap failed") }
	t.Cleanup(func() { launchAgentLoader = origLoader })

	cmd := newInstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	if err := cmd.RunE(cmd, nil); err == nil {
		t.Fatal("expected error when launchAgentLoader fails")
	}
}

// TestUninstallServiceCmd_RemovesPlistAndUnloads drives the full
// uninstall-service RunE with a fake launchAgentUnloader so the real
// launchctl is never invoked.
func TestUninstallServiceCmd_RemovesPlistAndUnloads(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	path := filepath.Join(tmp, "Library", "LaunchAgents", "tw.caliber.agent.plist")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("seed dir: %v", err)
	}
	if err := os.WriteFile(path, []byte("stub"), 0o644); err != nil {
		t.Fatalf("seed plist: %v", err)
	}

	var unloadedPath string
	origUnloader := launchAgentUnloader
	launchAgentUnloader = func(path string) { unloadedPath = path }
	t.Cleanup(func() { launchAgentUnloader = origUnloader })

	cmd := newUninstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatalf("RunE: %v", err)
	}
	if unloadedPath != path {
		t.Fatalf("unloadedPath = %q, want %q", unloadedPath, path)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("plist still present after uninstall-service")
	}
	if !strings.Contains(buf.String(), "removed") {
		t.Errorf("expected confirmation output, got %q", buf.String())
	}
}

// TestUninstallServiceCmd_Idempotent covers running uninstall-service when
// the plist was never installed: the unloader still fires (best-effort) but
// the missing-file remove must not error.
func TestUninstallServiceCmd_Idempotent(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	origUnloader := launchAgentUnloader
	launchAgentUnloader = func(string) {}
	t.Cleanup(func() { launchAgentUnloader = origUnloader })

	cmd := newUninstallServiceCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	if err := cmd.RunE(cmd, nil); err != nil {
		t.Fatalf("RunE (never installed): %v", err)
	}
}
