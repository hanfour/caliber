package wizard

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// Deps is the dependency bag for RunEnrollWizard. Splitting them out makes
// the wizard trivially testable: production wires real api.Client + keychain
// callbacks; tests pass fakes.
type Deps struct {
	Prompter  Prompter
	Scan      func(root string) ([]ProjectCandidate, error)
	Enroll    func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error)
	SetSecret func(account, secret string) error

	// Static metadata shipped in the enroll request body.
	Hostname     string
	OS           string
	AgentVersion string

	// Persisted into the new config.toml.
	APIBaseURL         string
	InsecureTransport  bool
	KeychainPath       string // custom keychain file; "" = login keychain (#168)
	ClaudeProjectsRoot string // typically ~/.claude/projects

	// WatchAll and Mode drive the non-interactive `caliber login` path
	// (spec Task 5): when WatchAll is set, RunEnrollWizard skips the
	// interactive path-selection prompt entirely and seeds IncludePaths
	// with both the Claude projects root and the Codex sessions root.
	WatchAll bool
	Mode     string // "" = wizard default (metadata-only); non-empty overrides
}

// LostKeyError is returned by RunEnrollWizard when the server returned a
// device key but the daemon could not persist it. The cli layer detects
// this via errors.As and emits the Failure-C user message (spec §5).
type LostKeyError struct {
	DeviceID string
	RawKey   string
	Cause    error
}

func (e *LostKeyError) Error() string {
	return fmt.Sprintf("api returned device key but local storage failed: %v", e.Cause)
}
func (e *LostKeyError) Unwrap() error { return e.Cause }

// RunEnrollWizard orchestrates the full enroll flow defined in spec §5.
// On success the function returns nil and the config has been written.
// On failure it returns a typed error suitable for cli.ExitFromErr.
func RunEnrollWizard(ctx context.Context, d Deps, token string) error {
	// Step 1: Confirm intent before anything observable happens.
	begin, err := d.Prompter.Confirm("Begin device enrollment with caliber?", true)
	if err != nil {
		return err
	}
	if !begin {
		return fmt.Errorf("enrollment cancelled by user")
	}

	// Step 2: Server credential exchange.
	resp, err := d.Enroll(ctx, api.EnrollRequest{
		Token:        token,
		Hostname:     d.Hostname,
		OS:           d.OS,
		AgentVersion: d.AgentVersion,
	})
	if err != nil {
		return err
	}

	// Step 3: Keychain. Failure here is Failure C — credentials are lost
	// because the API call already succeeded but we can't store them.
	if err := d.SetSecret(resp.DeviceID, resp.Key); err != nil {
		return &LostKeyError{DeviceID: resp.DeviceID, RawKey: resp.Key, Cause: err}
	}

	// Step 4: Initial config.toml with empty IncludePaths (privacy default).
	// SaveConfigInitial is the first-write-aware variant: it may MkdirAll the
	// root, but re-runs sentinel + partial-uninstall checks to catch the
	// runEnroll preflight → here TOCTOU window (R15-F2 / R16-F2).
	//
	// Mode defaults to "metadata-only" (privacy-first); d.Mode overrides it
	// whenever the caller set one (e.g. `--yes` defaults to "full-body" —
	// see cli.runEnroll — regardless of whether --watch-all is also set).
	mode := "metadata-only"
	if d.Mode != "" {
		mode = d.Mode
	}
	cfg := &config.Config{
		DeviceID:          resp.DeviceID,
		Hostname:          d.Hostname,
		OS:                d.OS,
		APIBaseURL:        d.APIBaseURL,
		Mode:              mode,
		IncludePaths:      []string{},
		InsecureTransport: d.InsecureTransport,
		KeychainPath:      d.KeychainPath,
	}
	if err := config.SaveConfigInitial(cfg); err != nil {
		return fmt.Errorf("config save: %w", err)
	}

	// Step 4b: non-interactive `caliber login` shortcut. When WatchAll is
	// set, skip the interactive path-selection prompt entirely and seed
	// IncludePaths with both the Claude projects root and the Codex
	// sessions root, canonicalized the same way the interactive path does.
	if d.WatchAll {
		cfg.IncludePaths = watchAllRoots(d.ClaudeProjectsRoot)
		if err := config.SaveConfig(cfg); err != nil {
			return fmt.Errorf("config save (watch-all paths): %w", err)
		}
		return nil
	}

	// Step 5: Scan + present candidate paths. Default is "none".
	cands, _ := d.Scan(d.ClaudeProjectsRoot)
	options := make([]string, 0, len(cands)+1)
	options = append(options, "None — start with 0 paths (recommended)")
	for _, c := range cands {
		options = append(options, c.CWD)
	}
	picks, err := d.Prompter.SelectMulti("Which projects should caliber-agent watch?", options)
	if err != nil {
		return err
	}
	selected := []string{}
	for _, idx := range picks {
		if idx == 0 {
			// "None" picked; treat as empty regardless of other picks.
			selected = []string{}
			break
		}
		if idx-1 < len(cands) {
			selected = append(selected, cands[idx-1].CWD)
		}
	}

	// Normalise each chosen path through EvalSymlinks + Clean so that the
	// watcher's allow-list contains canonical absolute paths only. Paths that
	// fail EvalSymlinks (broken symlink, race-removed dir) are skipped with a
	// stderr warning so the user can see why their N picks produced < N entries
	// (plan §8.2; re-prompting would be friendlier but is out of scope for PR4).
	include := make([]string, 0, len(selected))
	for _, p := range selected {
		resolved, ok := canonicalizePath(p)
		if !ok {
			continue
		}
		include = append(include, resolved)
	}

	// Step 6: Final confirm + write. SaveConfig is the runtime-flavored
	// writer: root must exist + precheckRuntime passes.
	confirmed, err := d.Prompter.Confirm(fmt.Sprintf("Save config with %d include_paths?", len(include)), true)
	if err != nil {
		return err
	}
	if !confirmed {
		return nil // wizard ends but keychain + initial config persist
	}
	cfg.IncludePaths = include
	if err := config.SaveConfig(cfg); err != nil {
		return fmt.Errorf("config save (paths): %w", err)
	}
	return nil
}

// canonicalizePath resolves p through EvalSymlinks + Clean so the watcher's
// allow-list only ever contains canonical absolute paths. ok is false (and a
// warning is printed to stderr) when EvalSymlinks fails — e.g. a broken
// symlink or a race-removed directory.
func canonicalizePath(p string) (resolved string, ok bool) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: skipping %q (cannot resolve: %v)\n", p, err)
		return "", false
	}
	return filepath.Clean(r), true
}

// watchAllRoots returns the canonicalized Claude projects root and Codex
// sessions root for the `--watch-all` non-interactive enroll path (spec
// Task 5). Roots that fail to canonicalize (e.g. they don't exist yet) are
// included Clean-only as a best-effort fallback so `caliber login` still
// seeds a usable config.toml even before the directories are created.
func watchAllRoots(claudeProjectsRoot string) []string {
	roots := make([]string, 0, 2)
	for _, root := range []string{claudeProjectsRoot, codexSessionsRoot()} {
		if root == "" {
			continue
		}
		if resolved, ok := canonicalizePath(root); ok {
			roots = append(roots, resolved)
		} else {
			roots = append(roots, filepath.Clean(root))
		}
	}
	return roots
}

// codexSessionsRoot returns the default ~/.codex/sessions path.
// CALIBER_CODEX_SESSIONS env overrides for advanced/dev use (see
// agent/README.md), mirroring cli.codexSessionsRoot (duplicated here since
// wizard cannot import the cli package without a cycle).
func codexSessionsRoot() string {
	if override := os.Getenv("CALIBER_CODEX_SESSIONS"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex", "sessions")
}
