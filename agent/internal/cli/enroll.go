package cli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
)

// testPrompterHook lets tests inject a FakePrompter without touching the
// production path. Production leaves this nil and falls through to the real
// stdin prompter. The useFakePrompter setter lives in export_test.go so that
// the "testing" package is never linked into the production binary.
var testPrompterHook wizard.Prompter

func newEnrollCmd() *cobra.Command {
	var apiBaseURL string
	var insecure bool
	var force bool
	var keychainPath string
	var yes bool
	var watchAll bool
	var mode string
	var backfillDays int
	cmd := &cobra.Command{
		Use:   "enroll <token>",
		Short: "Enrol this device with caliber using a one-shot enrollment token",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runEnroll(cmd, args[0], force, apiBaseURL, insecure, keychainPath, yes, watchAll, mode, backfillDays)
		},
	}
	cmd.Flags().StringVar(&apiBaseURL, "api-base-url", "", "caliber API URL (or set CALIBER_API_BASE_URL)")
	cmd.Flags().BoolVar(&insecure, "insecure", false, "allow http:// in api-base-url (dev/local only)")
	cmd.Flags().BoolVar(&force, "force", false, "re-enroll over an existing device")
	cmd.Flags().StringVar(&keychainPath, "keychain", "", "custom keychain file (unlock once via `security unlock-keychain`) for SSH/headless use; persisted to config so run/uninstall reuse it. Empty = login keychain")
	cmd.Flags().BoolVar(&yes, "yes", false, "non-interactive: accept all prompts (for caliber login)")
	cmd.Flags().BoolVar(&watchAll, "watch-all", false, "watch the entire Claude/Codex roots instead of prompting for paths")
	cmd.Flags().StringVar(&mode, "mode", "", "redaction mode: metadata-only|redacted-body|full-body (default full-body with --yes)")
	cmd.Flags().IntVar(&backfillDays, "backfill-days", 90, "only backfill sessions modified within this many days (0 = from now)")
	return cmd
}

func runEnroll(cmd *cobra.Command, token string, force bool, apiBaseURL string, insecure bool, keychainPath string, yes bool, watchAll bool, mode string, backfillDays int) error {
	// Validate --mode at the enroll boundary, before any observable side
	// effect (preflight I/O, API call, keychain/config write). An unvalidated
	// --mode would otherwise be persisted verbatim and only fail later when
	// `caliber-agent run` starts — too late for `caliber login` automation.
	// validRedactModes (run.go) is the same set `run` enforces at load time;
	// "" is valid here and means "use the wizard/--yes default" below.
	if !validRedactModes[mode] {
		return &ExitError{Code: 1, Err: fmt.Errorf("invalid --mode %q (must be one of: metadata-only, redacted-body, full-body)", mode)}
	}

	// Early preflight — R17-F1 / R18-F1 (spec §3.8).
	// Both checks run BEFORE config.Load / API call / keychain write so that
	// a partially-uninstalled state can never be "healed" by re-enrolling.
	root := config.RootDir()

	// (1) sentinel preflight — fail-closed on any stat error other than ErrNotExist.
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
		return &ExitError{Code: 1, Err: errors.New("[fatal] uninstall in progress; refusing to enroll")}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return &ExitError{Code: 1, Err: fmt.Errorf("[fatal] cannot stat uninstall sentinel (%v); failing closed", err)}
	}

	// (2) partial-cleanup preflight — root exists but config.toml missing means
	// ordered_delete (h) ran but (i) hasn't completed; manually remove root.
	if rootInfo, rErr := os.Stat(root); rErr == nil && rootInfo.IsDir() {
		if _, cErr := os.Stat(filepath.Join(root, "config.toml")); errors.Is(cErr, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] partial uninstall detected (root exists, config.toml missing); manually 'rm -rf ~/.caliber-agent/' then retry enroll")}
		}
	}

	// Already enrolled?
	if existing, err := config.Load(); err == nil && !force {
		return &ExitError{Code: 1, Err: fmt.Errorf("device already enrolled as %q; use --force to re-enroll", existing.DeviceID)}
	} else if err != nil && !errors.Is(err, config.ErrNotEnrolled) {
		return &ExitError{Code: 1, Err: err}
	}

	// Resolve API base URL: flag > env > (config — N/A during enroll).
	baseURL := apiBaseURL
	if baseURL == "" {
		baseURL = os.Getenv("CALIBER_API_BASE_URL")
	}
	if baseURL == "" {
		return &ExitError{Code: 1, Err: fmt.Errorf("API base URL not configured: pass --api-base-url or set CALIBER_API_BASE_URL")}
	}
	if err := config.ValidateAPIBaseURL(baseURL, insecure); err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("invalid api_base_url: %w", err)}
	}

	if yes && mode == "" {
		mode = "full-body"
	}
	prompter := wizard.Prompter(wizard.NewStdinPrompter())
	if testPrompterHook != nil {
		prompter = testPrompterHook
	} else if yes {
		prompter = wizard.AutoPrompter{}
	}

	hostname, hostnameErr := os.Hostname()
	if hostnameErr != nil && flags.Verbose {
		fmt.Fprintf(os.Stderr, "warning: os.Hostname() failed (%v); enrolling with empty hostname\n", hostnameErr)
	}
	osName := fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH)

	deps := wizard.Deps{
		Prompter: prompter,
		Scan:     wizard.ScanClaudeProjects,
		Enroll:   api.NewClient(baseURL, "caliber-agent/"+version.Version).Enroll,
		// Capture keychainPath in the closure so the wizard's SetSecret
		// stays a plain func(account, secret) and need not know about
		// keychain selection (#168).
		SetSecret: func(account, secret string) error {
			return keychain.Set(account, secret, keychainPath)
		},
		Hostname:           hostname,
		OS:                 osName,
		AgentVersion:       version.Version,
		APIBaseURL:         baseURL,
		InsecureTransport:  insecure,
		KeychainPath:       keychainPath,
		ClaudeProjectsRoot: claudeProjectsRoot(),
		WatchAll:           watchAll,
		Mode:               mode,
		BackfillDays:       backfillDays,
	}
	if err := wizard.RunEnrollWizard(cmd.Context(), deps, token); err != nil {
		return ExitFromErr(translateEnrollErr(err))
	}
	if cfg, lerr := config.Load(); lerr == nil {
		fmt.Fprintf(cmd.OutOrStdout(),
			"✓ Enrolled as device %s. Configured %d paths. Watcher arrives in next release.\n",
			cfg.DeviceID, len(cfg.IncludePaths))
	} else {
		// Should be unreachable — RunEnrollWizard just wrote it.
		fmt.Fprintln(cmd.OutOrStdout(), "✓ Enrolled. Watcher arrives in next release.")
	}
	return nil
}

func translateEnrollErr(err error) error {
	var lk *wizard.LostKeyError
	if errors.As(err, &lk) {
		// Failure C — emit raw key to stderr per spec §5 before propagating.
		fmt.Fprintf(os.Stderr,
			"ERROR: API returned a device key but local storage failed (%v).\n"+
				"  device_id: %s\n"+
				"  key:       %s\n"+
				"To clean up, revoke this device in /dashboard/devices and try again.\n"+
				"The key has NOT been saved locally and CANNOT be retrieved later.\n",
			lk.Cause, lk.DeviceID, lk.RawKey)
	}
	return err
}

// claudeProjectsRoot returns the default ~/.claude/projects path.
// CALIBER_CLAUDE_PROJECTS env overrides for advanced/dev use (see agent/README.md).
func claudeProjectsRoot() string {
	if override := os.Getenv("CALIBER_CLAUDE_PROJECTS"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.claude/projects"
}
