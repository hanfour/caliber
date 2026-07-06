//go:build !darwin

package cli

import "github.com/spf13/cobra"

// newInstallServiceCmd stubs `caliber-agent install-service` on non-macOS
// platforms: launchd is macOS-only. Run the daemon in the foreground with
// `caliber-agent run` instead (or wire your platform's own service manager).
func newInstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install-service",
		Short: "Install a resident service (macOS only; not yet implemented on this platform)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ExitNotImplemented("install-service: launchd resident mode is macOS-only; use `caliber-agent run` for foreground use")
		},
	}
}

// newUninstallServiceCmd stubs `caliber-agent uninstall-service` on
// non-macOS platforms.
func newUninstallServiceCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall-service",
		Short: "Remove a resident service (macOS only; not yet implemented on this platform)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return ExitNotImplemented("uninstall-service: launchd resident mode is macOS-only; use `caliber-agent run` for foreground use")
		},
	}
}
