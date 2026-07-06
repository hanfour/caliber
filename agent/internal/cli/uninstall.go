package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
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
	var keychainPath string
	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the daemon (revoke remote + remove keychain + delete local files)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runUninstall(cmd, yes, keepRemote, force, keychainPath)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip interactive consent prompt")
	cmd.Flags().BoolVar(&keepRemote, "keep-remote", false, "skip server-side revoke")
	cmd.Flags().BoolVar(&force, "force", false, "uninstall even if daemon is running")
	cmd.Flags().StringVar(&keychainPath, "keychain", "", "override the config's keychain file (unlock it first via `security unlock-keychain`); empty = use config / login keychain")
	return cmd
}

func runUninstall(cmd *cobra.Command, yes, keepRemote, force bool, keychainPath string) error {
	cfg, err := config.Load()
	if err != nil {
		if errors.Is(err, config.ErrNotEnrolled) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled; nothing to uninstall")}
		}
		return &ExitError{Code: 1, Err: err}
	}
	kcPath := resolveKeychainPath(keychainPath, cfg)

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
			"This will:\n  1. Revoke this device at %s (DELETE /v1/devices/me)\n  2. Remove %s (config, state, agent-config, redaction-set, agent.log, .lock, .uninstalling)\n  3. Remove keychain entry: %s / %s\nContinue? [y/N] ",
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
	return runUninstallCleanup(cmd, cfg, keepRemote, kcPath)
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

// osRemove is the package-level seam over os.Remove. Tests use the
// traceRemovesDuring helper to wrap this and record the exact order of
// remove calls uninstall makes. Production leaves it pointing at os.Remove.
var osRemove = os.Remove

// runUninstallCleanup performs steps 3-7 (sentinel → remote → keychain →
// ordered_delete → listing). The sentinel is written FIRST so any in-flight
// daemon writes that pass the per-tick / per-chunk check after we begin will
// notice and abort. The sentinel is restored on (a)-(g) ordered_delete
// failures and on keychain hard failures; it is NOT restored once (h) has
// removed it (R13-F2) — a retry of uninstall will rewrite a fresh sentinel.
func runUninstallCleanup(cmd *cobra.Command, cfg *config.Config, keepRemote bool, keychainPath string) error {
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
		token, kerr := keychain.Get(cfg.DeviceID, keychainPath)
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

	// restoreSentinel removes the sentinel so the daemon can recover if the
	// uninstall aborts mid-flight (R13-F1). It is called from any failure
	// path BEFORE step (h) removes the sentinel itself — see ordered_delete
	// comments below for the explicit no-restore boundary.
	restoreSentinel := func() { _ = osRemove(sentinelPath) }

	// STEP 5: keychain delete.
	//   - ErrNotFound is a soft failure: print a note and continue.
	//   - Any other error is hard: restore the absent state of .uninstalling
	//     (so the running daemon, if any, can resume on retry) and exit 1.
	if kerr := keychainDelete(cfg.DeviceID, keychainPath); kerr != nil {
		if errors.Is(kerr, keychain.ErrNotFound) {
			fmt.Fprintln(cmd.OutOrStdout(), "[ok] keychain entry already absent")
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "[error] keychain delete failed: %v\n", kerr)
			restoreSentinel()
			return &ExitError{Code: 1, Err: kerr}
		}
	}

	// STEP 6: ordered_delete (a)-(i). Spec §3.6 step 6 + R13/R14/R15.
	//
	// Invariant (R15): while config.toml exists on disk, .uninstalling must
	// also exist. The ordered_delete protects this by removing config.toml
	// (step g) BEFORE the sentinel (step h). Restoring the sentinel is
	// permitted on any failure in (a)-(g); once (h) deletes it, the invariant
	// no longer requires restoration — a retry of uninstall will simply
	// re-write a fresh sentinel.
	//
	// Steps (a)-(e) (optional artifacts): ErrNotExist is benign, any other
	// IO error is hard-fail with sentinel restore.
	optional := []string{"state.json", "redaction-set.json", "agent-config.json", "agent.log", "paused", ".lock"}
	for _, name := range optional {
		p := filepath.Join(root, name)
		if err := osRemove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(cmd.OutOrStdout(), "[error] remove %s: %v\n", p, err)
			restoreSentinel()
			return &ExitError{Code: 1, Err: err}
		}
	}

	// (f) tmp glob cleanup — leftover CreateTemp suffixes from atomic writes
	// in config.SaveConfig / state.Save / redactionset.Save. R13-F2 says any
	// failure here is hard-fail with restore so the operator can retry.
	for _, pattern := range []string{".config.toml.*", ".state.json.*", ".redaction-set.json.*", ".agent-config.json.*"} {
		matches, _ := filepath.Glob(filepath.Join(root, pattern))
		for _, m := range matches {
			if err := osRemove(m); err != nil && !errors.Is(err, fs.ErrNotExist) {
				fmt.Fprintf(cmd.OutOrStdout(), "[error] remove tmp %s: %v\n", m, err)
				restoreSentinel()
				return &ExitError{Code: 1, Err: err}
			}
		}
	}

	// (g) config.toml — must exist by construction (we Load()ed it at entry).
	// A failure here is hard-fail with sentinel restore.
	configPath := filepath.Join(root, "config.toml")
	if err := osRemove(configPath); err != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "[error] remove config.toml: %v\n", err)
		restoreSentinel()
		return &ExitError{Code: 1, Err: err}
	}

	// (h) .uninstalling — last file removed inside the dir. From this point
	// on, failures DO NOT restore the sentinel (R13-F2): config.toml is gone
	// and re-creating .uninstalling without re-creating config.toml would
	// permanently confuse the enroll preflight.
	if err := osRemove(sentinelPath); err != nil {
		fmt.Fprintf(cmd.OutOrStdout(),
			"[error] failed to remove sentinel; .uninstalling may persist — manual cleanup: rm %s && rmdir %s\n",
			sentinelPath, root)
		return &ExitError{Code: 1, Err: err}
	}

	// (i) rmdir — the directory should now be empty. A non-empty dir means
	// the operator dropped extra files in ~/.caliber-agent/ that the
	// explicit cleanup steps did not anticipate; surface a friendly error
	// and let them inspect manually. R13-F2: do NOT restore the sentinel.
	if err := osRemove(root); err != nil {
		fmt.Fprintf(cmd.OutOrStdout(),
			"[error] rmdir failed: %v; inspect %s for leftover files and manually 'rm -rf' if confirmed safe\n",
			err, root)
		return &ExitError{Code: 1, Err: err}
	}

	// STEP 7: final listing. Names the categories of artifact that were touched
	// (remote / keychain / local fs) for operator audit. DeviceID is included on
	// the remote-success line because it's the same value the web UI shows; it
	// is NOT a secret (the cda_* token is, and that is never printed).
	fmt.Fprintln(cmd.OutOrStdout(), "Removed:")
	switch remoteState {
	case remoteRevoked:
		fmt.Fprintf(cmd.OutOrStdout(), "  ✓ remote device %s (server: revoked)\n", cfg.DeviceID)
	case remoteFailed, remoteNoToken:
		fmt.Fprintf(cmd.OutOrStdout(),
			"  ✗ remote (failed; revoke manually at %s/dashboard/devices)\n", cfg.APIBaseURL)
	case remoteSkipped:
		fmt.Fprintln(cmd.OutOrStdout(), "  - remote (skipped via --keep-remote)")
	}
	fmt.Fprintf(cmd.OutOrStdout(), "  ✓ keychain entry %s / %s\n", keychain.ServiceName, cfg.DeviceID)
	fmt.Fprintln(cmd.OutOrStdout(), "  ✓ ~/.caliber-agent/")
	return nil
}
