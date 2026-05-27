package cli

import (
	"errors"
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// newRemovePathCmd wires `caliber-agent remove-path <path>`. Spec §3.2.
//
// Unlike add-path, remove-path is broken-symlink-tolerant: EvalSymlinks may
// fail (the directory was deleted out from under us) but the entry can still
// live in config.toml from a previous enroll. We fall back to filepath.Clean
// on the raw argument and additionally match against the raw string so the
// user can copy/paste whatever they see in `status` output.
//
// No --yes flag: remove-path is a "shrink the allow-list" op, which lowers
// the upload surface. Consent banners exist to gate _expansions_ of trust
// (add-path / enroll), not contractions.
func newRemovePathCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove-path <path>",
		Short: "Remove a project path from the allow-list",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRemovePath(cmd, args[0])
		},
	}
	return cmd
}

func runRemovePath(cmd *cobra.Command, raw string) error {
	// Best-effort normalise. EvalSymlinks failures (broken symlink, deleted
	// target) fall back to filepath.Clean(raw) so we can still match the
	// stored entry.
	normalised := filepath.Clean(raw)
	if resolved, err := filepath.EvalSymlinks(raw); err == nil {
		normalised = filepath.Clean(resolved)
	}

	cfg, err := config.Load()
	if err != nil {
		if errors.Is(err, config.ErrNotEnrolled) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled; run 'caliber-agent enroll <token>' first")}
		}
		return &ExitError{Code: 1, Err: err}
	}

	kept := make([]string, 0, len(cfg.IncludePaths))
	removed := false
	for _, p := range cfg.IncludePaths {
		if p == normalised || p == raw {
			removed = true
			continue
		}
		kept = append(kept, p)
	}
	if !removed {
		fmt.Fprintf(cmd.OutOrStdout(), "not in list: %s\n", raw)
		return nil
	}

	cfg.IncludePaths = kept
	if err := config.SaveConfig(cfg); err != nil {
		return ExitFromErr(err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "[ok] removed %s\n", raw)
	return nil
}
