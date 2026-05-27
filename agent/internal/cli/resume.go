package cli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// newResumeCmd wires `caliber-agent resume`. Spec §3.4.
//
// Behaviour summary:
//   - Removes the paused sentinel. Idempotent: ErrNotExist prints
//     "not paused" and exits 0.
//   - Any other IO error during the remove maps to exit 1.
//   - No pre-flight stat dance is needed (unlike pause) — resume is a pure
//     "stop the previous pause" operation that should work even if the
//     daemon was uninstalled out from under us (the unlink targets a file
//     that may or may not exist; both outcomes are benign).
func newResumeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "resume",
		Short: "Resume syncing (remove the paused sentinel)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runResume(cmd)
		},
	}
}

func runResume(cmd *cobra.Command) error {
	if err := os.Remove(config.PausedPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintln(cmd.OutOrStdout(), "not paused")
			return nil
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("rm paused: %w", err)}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "resumed.")
	return nil
}
