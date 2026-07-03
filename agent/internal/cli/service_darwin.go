//go:build darwin

package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

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
			fmt.Fprintln(cmd.OutOrStdout(), "caliber-agent installed as a launchd service")
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
)

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
