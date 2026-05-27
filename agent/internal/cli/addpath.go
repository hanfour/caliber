package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// newAddPathCmd wires the `caliber-agent add-path <absolute-path>` cobra
// command. Spec §3.1.
//
// Behaviour summary (R7 consent banner):
//   - One positional argument; must be absolute.
//   - --yes skips the interactive consent prompt entirely.
//   - With no --yes and a non-TTY stdin, exits 130 (refuse to act without
//     explicit confirmation) BEFORE any disk mutation.
//   - Path is normalised through EvalSymlinks + Clean so the watcher's
//     allow-list contains canonical paths (consistent with Phase 8 wizard).
func newAddPathCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "add-path <absolute-path>",
		Short: "Add a project path to the allow-list",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAddPath(cmd, args[0], yes)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip interactive consent prompt")
	return cmd
}

func runAddPath(cmd *cobra.Command, raw string, yes bool) error {
	if !filepath.IsAbs(raw) {
		return &ExitError{Code: 64, Err: fmt.Errorf("add-path requires absolute path: %q", raw)}
	}

	// Canonicalise the path (EvalSymlinks fails on non-existent paths, so
	// this also serves as the existence probe).
	resolved, err := filepath.EvalSymlinks(raw)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: fmt.Errorf("path does not exist: %s", raw)}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("cannot resolve path %q: %w", raw, err)}
	}
	normalised := filepath.Clean(resolved)
	info, err := os.Stat(normalised)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: fmt.Errorf("path does not exist: %s", raw)}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat %s: %w", normalised, err)}
	}
	if !info.IsDir() {
		return &ExitError{Code: 1, Err: fmt.Errorf("not a directory: %s", normalised)}
	}

	cfg, err := config.Load()
	if err != nil {
		if errors.Is(err, config.ErrNotEnrolled) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled; run 'caliber-agent enroll <token>' first")}
		}
		return &ExitError{Code: 1, Err: err}
	}
	for _, p := range cfg.IncludePaths {
		if p == normalised {
			fmt.Fprintf(cmd.OutOrStdout(), "already in list: %s\n", normalised)
			return nil
		}
	}

	if !yes {
		// R7 contract: refuse to mutate without explicit confirmation when
		// stdin is not a terminal. Check BEFORE writing the consent banner
		// to avoid printing a prompt that nothing can answer.
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return &ExitError{Code: 130, Err: errors.New("non-interactive shell detected; pass --yes to confirm add-path")}
		}
		fmt.Fprintf(cmd.OutOrStdout(),
			"This will watch %s and upload transcript content found under it to %s (mode: %s). Continue? [y/N] ",
			normalised, cfg.APIBaseURL, cfg.Mode)
		reader := bufio.NewReader(os.Stdin)
		ans, _ := reader.ReadString('\n')
		ans = strings.ToLower(strings.TrimSpace(ans))
		if ans != "y" && ans != "yes" {
			return &ExitError{Code: 130, Err: errors.New("user declined")}
		}
	}

	cfg.IncludePaths = append(cfg.IncludePaths, normalised)
	if err := config.SaveConfig(cfg); err != nil {
		return ExitFromErr(err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "[ok] added %s; restart 'caliber-agent run' to pick it up\n", normalised)
	return nil
}
