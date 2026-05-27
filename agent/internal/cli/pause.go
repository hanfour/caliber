package cli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// newPauseCmd wires `caliber-agent pause`. Spec §3.3.
//
// Behaviour summary:
//   - All read-only stat checks happen BEFORE any write IO. Order mirrors
//     `run`'s pre-flight (root → .uninstalling → config.toml) so the most
//     recent uninstall state is detected first.
//   - R9-F1 fail-closed: if `.uninstalling` exists (or stat returns a non-
//     ErrNotExist error), refuse to create the paused sentinel. We do NOT
//     want to introduce a new sentinel during the uninstall cleanup window.
//   - Idempotent: re-pausing rewrites the empty sentinel and exits 0.
func newPauseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pause",
		Short: "Pause syncing (running daemon will skip ticks)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPause(cmd)
		},
	}
}

func runPause(cmd *cobra.Command) error {
	root := config.RootDir()
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled; run `caliber-agent enroll <token>` first")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat root: %w", err)}
	}
	// R9-F1 fail-closed: presence OR any non-ErrNotExist stat error means
	// uninstall may be in progress. Refuse rather than risk dropping a new
	// sentinel into a directory that's about to be ordered_deleted.
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return &ExitError{Code: 1, Err: errors.New("[fatal] uninstall in progress; refusing to pause")}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return &ExitError{Code: 1, Err: fmt.Errorf("[fatal] uninstall in progress (sentinel stat: %v; fail-closed)", err)}
	}
	if _, err := os.Stat(config.ConfigPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled (config.toml missing — partial cleanup?)")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat config.toml: %w", err)}
	}
	if err := os.WriteFile(config.PausedPath(), []byte{}, 0o600); err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("write paused: %w", err)}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "paused. running daemon will skip ticks on next interval. resume with 'caliber-agent resume'.")
	return nil
}
