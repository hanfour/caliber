//go:build darwin

package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/service"
)

// newInstallServiceCmd wires `caliber-agent install-service` (macOS only).
// It writes a launchd LaunchAgent plist pointed at the current executable
// and bootstraps it into the user's gui/<uid> domain so the daemon runs
// resident and restarts on login (RunAtLoad + KeepAlive).
func newInstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install-service",
		Short: "Install the launchd LaunchAgent (macOS resident mode)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			exe, err := os.Executable()
			if err != nil {
				return &ExitError{Code: 1, Err: fmt.Errorf("resolve executable: %w", err)}
			}
			if resolved, err := filepath.EvalSymlinks(exe); err == nil {
				exe = resolved
			}
			path, err := writeLaunchAgentPlist(exe, config.LogPath())
			if err != nil {
				return &ExitError{Code: 1, Err: err}
			}
			if err := launchAgentLoader(path); err != nil {
				return &ExitError{Code: 1, Err: err}
			}
			// #253: bootstrap succeeding is NOT proof the daemon runs. The
			// job can silently exit 0 (KeepAlive{SuccessfulExit:false} then
			// never retries), leaving "installed but not running" — a
			// telemetry blind spot where a member believes they're recording
			// when they aren't. Confirm a live PID and fail loudly with a
			// kickstart remediation if it never appears.
			pid, ok := waitForLaunchAgent(service.LaunchAgentLabel)
			if !ok {
				uid := os.Getuid()
				return &ExitError{Code: 1, Err: fmt.Errorf(
					"launchd service installed but not running — start it with:\n"+
						"  launchctl kickstart -k gui/%d/%s",
					uid, service.LaunchAgentLabel)}
			}
			fmt.Fprintf(cmd.OutOrStdout(), "caliber-agent installed as a launchd service (pid %d)\n", pid)
			return nil
		},
	}
}

// newUninstallServiceCmd wires `caliber-agent uninstall-service` (macOS
// only). It is idempotent: running it when the service was never installed
// (or is already unloaded) succeeds rather than erroring.
func newUninstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall-service",
		Short: "Remove the launchd LaunchAgent",
		RunE: func(cmd *cobra.Command, _ []string) error {
			path := service.LaunchAgentPath()
			launchAgentUnloader(path)
			if err := removeLaunchAgentPlist(path); err != nil {
				return &ExitError{Code: 1, Err: err}
			}
			fmt.Fprintln(cmd.OutOrStdout(), "caliber-agent launchd service removed")
			return nil
		},
	}
}

// writeLaunchAgentPlist renders the plist for execPath/logPath and writes it
// to service.LaunchAgentPath(), creating the parent LaunchAgents directory
// if needed. It touches no launchctl state, so it is fully unit-testable
// (e.g. with HOME overridden via t.Setenv) without mutating the real
// launchd domain.
func writeLaunchAgentPlist(execPath, logPath string) (string, error) {
	plist, err := service.RenderPlist(execPath, logPath)
	if err != nil {
		return "", fmt.Errorf("render plist: %w", err)
	}
	path := service.LaunchAgentPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("mkdir LaunchAgents: %w", err)
	}
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return "", fmt.Errorf("write plist: %w", err)
	}
	return path, nil
}

// removeLaunchAgentPlist deletes the plist at path, treating "already gone"
// as success (uninstall-service must be idempotent).
func removeLaunchAgentPlist(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist: %w", err)
	}
	return nil
}

// launchAgentLoader / launchAgentUnloader are indirections over
// loadLaunchAgent / unloadLaunchAgent so tests can substitute a fake and
// exercise the full install-service / uninstall-service RunE flow without
// invoking the real launchctl, which would mutate the dev/CI machine's
// launchd state.
var (
	launchAgentLoader   = loadLaunchAgent
	launchAgentUnloader = unloadLaunchAgent
	// launchAgentPID reports the running job's PID (and whether it is
	// running at all) so install-service can verify the daemon actually
	// started. Indirected for tests (real launchctl would need a live job).
	launchAgentPID = launchdJobPID
	// Poll budget for waitForLaunchAgent: RunAtLoad can take a moment to
	// materialise a PID. ~5s total (10 × 500ms). Overridable in tests so
	// the never-running path doesn't wait the full budget.
	launchAgentPollAttempts = 10
	launchAgentPollDelay    = 500 * time.Millisecond
)

// waitForLaunchAgent polls launchAgentPID until the job reports a live PID or
// the attempt budget is exhausted. Returns (pid, true) once running, or
// (0, false) if it never came up.
func waitForLaunchAgent(label string) (int, bool) {
	for i := 0; i < launchAgentPollAttempts; i++ {
		if pid, ok := launchAgentPID(label); ok {
			return pid, true
		}
		if i < launchAgentPollAttempts-1 {
			time.Sleep(launchAgentPollDelay)
		}
	}
	return 0, false
}

// launchdJobPidRe extracts the numeric PID from `launchctl list <label>`
// output, whose running form contains a line like `	"PID" = 12345;`.
var launchdJobPidRe = regexp.MustCompile(`"PID"\s*=\s*(\d+)`)

// launchdJobPID queries `launchctl list <label>` and parses the job's PID.
// A job that is loaded-but-not-running has no PID key → (0, false); an
// unloaded job makes launchctl exit non-zero → (0, false).
func launchdJobPID(label string) (int, bool) {
	out, err := exec.Command("launchctl", "list", label).CombinedOutput()
	if err != nil {
		return 0, false
	}
	m := launchdJobPidRe.FindSubmatch(out)
	if m == nil {
		return 0, false
	}
	pid, err := strconv.Atoi(string(m[1]))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// loadLaunchAgent bootstraps path into the caller's gui/<uid> launchd
// domain. A preceding bootout is best-effort: the job may not be loaded yet
// (first install), which is not an error condition.
func loadLaunchAgent(path string) error {
	uid := fmt.Sprintf("gui/%d", os.Getuid())
	_ = exec.Command("launchctl", "bootout", uid, path).Run()
	if out, err := exec.Command("launchctl", "bootstrap", uid, path).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w: %s", err, out)
	}
	return nil
}

// unloadLaunchAgent boots path out of the caller's gui/<uid> launchd domain.
// Best-effort: failure (e.g. job not loaded) is intentionally ignored so
// uninstall-service stays idempotent.
func unloadLaunchAgent(path string) {
	uid := fmt.Sprintf("gui/%d", os.Getuid())
	_ = exec.Command("launchctl", "bootout", uid, path).Run()
}
