package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
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

// remoteRevokeState records what we did with the server side so the final
// listing in step 7 can summarise it. Mutated only inside runUninstallCleanup.
type remoteRevokeState string

const (
	remoteSkipped remoteRevokeState = "skipped"
	remoteRevoked remoteRevokeState = "revoked"
	remoteFailed  remoteRevokeState = "failed"
	remoteNoToken remoteRevokeState = "failed (no token)"
)

// keychainDelete is the package-level seam over keychain.Delete. Tests use
// the withKeychainDelete helper (export_test.go) to swap this for a stub
// that returns ErrNotFound or a synthetic permission error without spawning
// the real `security` binary. Production callers never touch this var.
var keychainDelete = keychain.Delete

// runUninstallCleanup performs steps 3-7 (sentinel → remote → keychain →
// ordered_delete → listing). The sentinel is written FIRST so any in-flight
// daemon writes that pass the per-tick / per-chunk check after we begin will
// notice and abort. The sentinel is restored on (a)-(g) ordered_delete
// failures and on keychain hard failures; it is NOT restored once (h) has
// removed it (R13-F2) — a retry of uninstall will rewrite a fresh sentinel.
func runUninstallCleanup(cmd *cobra.Command, cfg *config.Config, keepRemote bool) error {
	root := config.RootDir()
	sentinelPath := filepath.Join(root, ".uninstalling")

	// STEP 3: write `.uninstalling` sentinel (empty, 0o600).
	// Root must already exist (we loaded config.toml from it). If the
	// sentinel write fails we have not yet mutated anything irreversible;
	// exit 1 so the operator can investigate the underlying IO error.
	if err := os.WriteFile(sentinelPath, []byte{}, 0o600); err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("write sentinel: %w", err)}
	}

	// STEP 4: best-effort remote revoke (unless --keep-remote).
	remoteState := remoteSkipped
	if !keepRemote {
		ctx := context.Background()
		token, kerr := keychain.Get(cfg.DeviceID)
		if kerr != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "[warn] keychain Get failed: %v; cannot revoke remotely\n", kerr)
			remoteState = remoteNoToken
		} else {
			apiClient := api.NewClient(cfg.APIBaseURL, "caliber-agent/uninstall")
			if rerr := apiClient.RevokeSelf(ctx, token); rerr != nil {
				fmt.Fprintf(cmd.OutOrStdout(), "[warn] remote revoke failed: %v; continuing local cleanup\n", rerr)
				remoteState = remoteFailed
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), "[ok] device revoked at server")
				remoteState = remoteRevoked
			}
		}
	} else {
		fmt.Fprintf(cmd.OutOrStdout(),
			"Skipped remote revoke (--keep-remote). Manually revoke at %s/dashboard/devices.\n",
			cfg.APIBaseURL)
	}

	// STEP 5: keychain delete.
	//   - ErrNotFound is a soft failure: print a note and continue.
	//   - Any other error is hard: restore the absent state of .uninstalling
	//     (so the running daemon, if any, can resume on retry) and exit 1.
	if kerr := keychainDelete(cfg.DeviceID); kerr != nil {
		if errors.Is(kerr, keychain.ErrNotFound) {
			fmt.Fprintln(cmd.OutOrStdout(), "[ok] keychain entry already absent")
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "[error] keychain delete failed: %v\n", kerr)
			_ = os.Remove(sentinelPath) // restore so daemon can recover
			return &ExitError{Code: 1, Err: kerr}
		}
	}

	// STEP 6 (ordered_delete) and STEP 7 (listing) land in subsequent
	// phase 11 tasks. For now consume locals.
	_ = sentinelPath
	_ = remoteState
	return nil
}
