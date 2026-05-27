package cli

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"
)

// newUninstallCmd wires `caliber-agent uninstall`. Spec §3.6.
//
// Behaviour summary (R7/R13/R14/R15):
//   - Three flags: --yes (skip prompt), --keep-remote (skip server revoke),
//     --force (proceed even if daemon currently holds .lock; R7-F2 means
//     force bypasses lockfile.Probe entirely — the daemon sees the
//     .uninstalling sentinel on its next per-chunk check and exits).
//   - lockfile.Probe is no-O_CREATE: a missing .lock means no daemon is
//     running and uninstall proceeds. Probe is the only signal of "active
//     daemon" — we do not kill -0 the recorded PID because PID reuse on
//     macOS could lead to false positives.
//   - The .uninstalling sentinel is written ONLY after the user (or --yes)
//     confirms; declined / non-TTY refusals must leave the filesystem
//     untouched.
func newUninstallCmd() *cobra.Command {
	var yes, keepRemote, force bool
	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the daemon (revoke remote + remove keychain + delete local files)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runUninstall(cmd, yes, keepRemote, force)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip interactive consent prompt")
	cmd.Flags().BoolVar(&keepRemote, "keep-remote", false, "skip server-side revoke")
	cmd.Flags().BoolVar(&force, "force", false, "uninstall even if daemon is running")
	return cmd
}

func runUninstall(cmd *cobra.Command, yes, keepRemote, force bool) error {
	cfg, err := config.Load()
	if err != nil {
		if errors.Is(err, config.ErrNotEnrolled) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled; nothing to uninstall")}
		}
		return &ExitError{Code: 1, Err: err}
	}

	// STEP 1: no-create, no-acquire probe of .lock (R7-F1).
	// --force skips the probe entirely (R7-F2); the sentinel + per-chunk
	// check in the running daemon is the only stop signal we rely on.
	if !force {
		holder, perr := lockfile.Probe(config.LockPath())
		if errors.Is(perr, lockfile.ErrLocked) {
			msg := "caliber-agent run is currently active"
			if holder > 0 {
				msg = fmt.Sprintf("caliber-agent run is currently active (PID %d)", holder)
			}
			return &ExitError{Code: 1, Err: fmt.Errorf("%s.\nStop it first with Ctrl+C, then re-run uninstall.\nOr pass --force to signal the daemon to exit and proceed with cleanup", msg)}
		}
		// Other probe errors (ErrNotExist / unheld) → treat as no daemon
		// running and proceed.
	}

	// STEP 2: prompt + confirm. Refuse to mutate without explicit consent
	// when stdin is not a TTY.
	if !yes {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return &ExitError{Code: 130, Err: errors.New("non-interactive shell detected; pass --yes to confirm uninstall")}
		}
		fmt.Fprintf(cmd.OutOrStdout(),
			"This will:\n  1. Revoke this device at %s (DELETE /v1/devices/me)\n  2. Remove %s (config, state, redaction-set, agent.log, .lock, .uninstalling)\n  3. Remove keychain entry: %s / %s\nContinue? [y/N] ",
			cfg.APIBaseURL, config.RootDir(), keychain.ServiceName, cfg.DeviceID)
		reader := bufio.NewReader(os.Stdin)
		ans, _ := reader.ReadString('\n')
		ans = strings.ToLower(strings.TrimSpace(ans))
		if ans != "y" && ans != "yes" {
			return &ExitError{Code: 130, Err: errors.New("user declined")}
		}
	}

	// Phase 11.1 ends here; phase 11.2 adds the sentinel write + remote
	// revoke + keychain + ordered_delete + listing in runUninstallCleanup.
	return runUninstallCleanup(cmd, cfg, keepRemote)
}

// runUninstallCleanup performs steps 3-7 (sentinel → remote → keychain →
// ordered_delete → listing). Phase 11.1 ships a stub that returns nil so
// the probe/prompt tests can pass; phases 11.2-11.5 fill in the body.
func runUninstallCleanup(_ *cobra.Command, _ *config.Config, _ bool) error {
	return nil
}
