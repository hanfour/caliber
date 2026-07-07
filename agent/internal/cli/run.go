package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
	"github.com/hanfour/ai-dev-eval/agent/redact"
	"github.com/hanfour/ai-dev-eval/agent/redact/parser"
	"github.com/hanfour/ai-dev-eval/agent/sink"
	"github.com/hanfour/ai-dev-eval/agent/watcher"
)

// validRedactModes is the set of legal --mode / cfg.Mode values, shared by
// the run-time load check (below) and the enroll-time boundary check
// (enroll.go) so both sides of `caliber login` agree on what's legal.
// Empty string is valid: it means "no override" — run.go defaults it to
// ModeMetadataOnly, and enroll.go leaves the wizard/--yes default in place.
var validRedactModes = map[string]bool{
	string(redact.ModeMetadataOnly): true,
	string(redact.ModeRedactedBody): true,
	string(redact.ModeFullBody):     true,
	"":                              true,
}

func newRunCmd() *cobra.Command {
	var once bool
	var interval time.Duration
	var keychainPath string
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the daemon main loop (foreground; you start and stop it manually)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runRun(cmd, once, interval, keychainPath)
		},
	}
	cmd.Flags().BoolVar(&once, "once", false, "run a single tick then exit (smoke-test affordance)")
	cmd.Flags().DurationVar(&interval, "interval", 60*time.Second, "polling interval (advanced; default 60s)")
	cmd.Flags().StringVar(&keychainPath, "keychain", "", "override the config's keychain file (unlock it first via `security unlock-keychain`); empty = use config / login keychain")
	return cmd
}

// resolveKeychainPath picks the keychain file the `security` CLI should
// target: an explicit --keychain flag wins, otherwise the value persisted
// in config at enroll time, otherwise "" (login keychain). Shared by run
// and uninstall (#168).
func resolveKeychainPath(flagVal string, cfg *config.Config) string {
	if flagVal != "" {
		return flagVal
	}
	return cfg.KeychainPath
}

// Defense-in-depth bounds on the server-driven poll interval. The server
// already clamps agent-config responses to this range, but the daemon
// clamps again client-side so a buggy or compromised response can never
// force an unreasonable tick rate.
const (
	minAgentConfigInterval = 30 * time.Second
	maxAgentConfigInterval = 1800 * time.Second
)

// clampAgentConfigInterval enforces [minAgentConfigInterval, maxAgentConfigInterval].
func clampAgentConfigInterval(d time.Duration) time.Duration {
	if d < minAgentConfigInterval {
		return minAgentConfigInterval
	}
	if d > maxAgentConfigInterval {
		return maxAgentConfigInterval
	}
	return d
}

// refreshAgentConfig fetches GET /v1/agent-config, clamps the returned poll
// interval, applies it to prov, and persists the result to disk so the next
// startup can seed from cache before the first fetch completes. On fetch
// error it logs and leaves prov untouched — the caller keeps running on
// whatever interval was already active (cache / --interval flag / default).
func refreshAgentConfig(ctx context.Context, client *api.Client, token string, prov *watcher.IntervalProvider, logger Logger) {
	fresh, err := client.FetchAgentConfig(ctx, token)
	if err != nil {
		logger.Printf("[warn] agent-config refresh failed (err=%v)", err)
		return
	}
	interval := clampAgentConfigInterval(time.Duration(fresh.PollIntervalSeconds) * time.Second)
	prov.Set(interval)
	ac := &config.AgentConfig{
		PollIntervalSeconds: int64(interval / time.Second),
		TTLSeconds:          fresh.TTLSeconds,
		FetchedAt:           time.Now().UTC(),
	}
	if serr := config.SaveAgentConfig(ac); serr != nil {
		logger.Printf("[warn] agent-config save failed (err=%v)", serr)
	}
	logger.Printf("[refresh] agent-config poll_interval=%s ttl=%ds", interval, fresh.TTLSeconds)
}

// fatalExitFor maps auth-fatal sentinels to the correct ExitError. Returns nil
// for non-fatal errors so the caller can continue with normal error handling.
// key_revoked → exit 0 (operator action required, not a daemon crash)
// invalid_token → exit 1 (configuration error)
func fatalExitFor(err error) *ExitError {
	if errors.Is(err, api.ErrKeyRevoked) {
		return &ExitError{Code: 0, Err: err}
	}
	if errors.Is(err, api.ErrInvalidToken) {
		return &ExitError{Code: 1, Err: err}
	}
	return nil
}

func runRun(cmd *cobra.Command, once bool, interval time.Duration, keychainPath string) error {
	// Emit a startup marker to stderr as the VERY first action, before any
	// branch that can exit early (#253). Under launchd, stderr is redirected
	// to agent.log, and the RFC logger below is only constructed after the
	// pre-flight checks + a SIGTERM-sensitive setup — so an early exit (or a
	// SIGTERM racing bootstrap) used to leave the log completely empty,
	// making "installed but silently never ran" indistinguishable from a
	// healthy start. This line guarantees every run is self-diagnosing.
	fmt.Fprintf(cmd.ErrOrStderr(), "%s [start] caliber-agent %s pid=%d\n",
		time.Now().UTC().Format(time.RFC3339), version.Version, os.Getpid())

	// STEP 1: pre-flight read-only checks. Spec §3.7 / R8-F1 / R9-F1 / R16-F1.
	// Order is reverse-aligned with ordered_delete (root → sentinel → config)
	// so the most-recently-occurred uninstall state is detected first. NO write
	// IO is permitted in this block — not even an O_CREATE on .lock.
	root := config.RootDir()
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("not enrolled (config directory missing); run `caliber-agent enroll <token>` first")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat root: %w", err)}
	}
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return &ExitError{Code: 0, Err: errors.New("uninstall in progress; aborting startup")}
	} else if !errors.Is(err, fs.ErrNotExist) {
		// fail-closed on non-ErrNotExist stat errors (spec §7).
		return &ExitError{Code: 0, Err: fmt.Errorf("uninstall in progress (sentinel stat: %v; fail-closed)", err)}
	}
	if _, err := os.Stat(config.ConfigPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("not enrolled (config.toml missing — partial cleanup?); re-enroll or remove ~/.caliber-agent/")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat config.toml: %w", err)}
	}

	// STEP 2: acquire lockfile + write PID. Spec §3.7 step 2 / R4-F1 / R7-F2.
	// The lock fd MUST be held until process exit — defer Release closes the
	// fd which the kernel uses to drop the flock.
	lk, err := lockfile.Acquire(config.LockPath())
	if err != nil {
		if errors.Is(err, lockfile.ErrLocked) {
			return &ExitError{Code: 1, Err: errors.New("another caliber-agent run is already active")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("acquire lock: %w", err)}
	}
	defer lk.Release()

	// STEP 3: post-lock sentinel re-check. Spec §3.7 step 3 / R9-F1.
	// Catches the pre-flight → Acquire window where uninstall wrote the
	// sentinel between our stat and our flock. Fail-closed on non-ErrNotExist
	// stat errors. The lockfile we just acquired is harmless to leave behind:
	// uninstall's ordered_delete will sweep it during step (g).
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return &ExitError{Code: 0, Err: errors.New("uninstall in progress (detected post-lock); aborting startup")}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return &ExitError{Code: 0, Err: fmt.Errorf("uninstall in progress (post-lock sentinel stat: %v; fail-closed)", err)}
	}

	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("device not enrolled; run `caliber-agent enroll` first: %w", err)}
	}
	key, err := keychain.Get(cfg.DeviceID, resolveKeychainPath(keychainPath, cfg))
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("device key missing from keychain; re-run `caliber-agent enroll`: %w", err)}
	}

	// Validate cfg.Mode before constructing chunker. An unknown mode would
	// cause ApplyMode's switch to fall through, shipping content unredacted.
	if !validRedactModes[cfg.Mode] {
		return &ExitError{Code: 1, Err: fmt.Errorf("config: invalid mode %q (must be one of: metadata-only, redacted-body, full-body)", cfg.Mode)}
	}
	mode := redact.Mode(cfg.Mode)
	if mode == "" {
		mode = redact.ModeMetadataOnly
	}

	state, err := config.LoadState()
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("load state: %w", err)}
	}
	logFile, err := config.OpenAgentLog()
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("open agent.log: %w", err)}
	}
	defer logFile.Close()
	logger := config.NewRFCLogger(io.MultiWriter(logFile, cmd.ErrOrStderr()))

	// Construct api client.
	apiClient := api.NewClient(cfg.APIBaseURL, "caliber-agent/"+version.Version)

	// Bootstrap redaction set (3-tier fallback inside).
	setProvider, err := BootstrapRedactionSet(cmd.Context(), apiClient, key, logger)
	if err != nil {
		if ee := fatalExitFor(err); ee != nil {
			logger.Printf("[fatal] device key revoked by caliber server")
			logger.Printf("[fatal] Action: run `caliber-agent enroll <new-token>` to re-enroll this device")
			return ee
		}
		logger.Printf("[fatal] redaction-set bootstrap failed: %v", err)
		return &ExitError{Code: 1, Err: err}
	}

	// Background refresher goroutine.
	go func() {
		for {
			ttl := time.Duration(setProvider.Current().TTLSeconds) * time.Second
			if ttl <= 0 {
				ttl = 24 * time.Hour
			}
			select {
			case <-cmd.Context().Done():
				return
			case <-time.After(ttl):
			}
			fresh, ferr := apiClient.FetchRedactionSet(cmd.Context(), key)
			if ferr != nil {
				if errors.Is(ferr, api.ErrKeyRevoked) || errors.Is(ferr, api.ErrInvalidToken) {
					logger.Printf("[fatal] redaction-set refresh hit auth failure: %v", ferr)
					return
				}
				logger.Printf("[warn] redaction-set refresh failed (err=%v)", ferr)
				continue
			}
			set := &redact.RedactionSet{
				Patterns:   fresh.Patterns,
				Version:    fresh.Version,
				FetchedAt:  time.Now().UTC(),
				TTLSeconds: fresh.TTLSeconds,
			}
			if err := set.Compile(); err != nil {
				// ErrTooManyPatterns is a hard rejection — discard the
				// fetched set and keep the currently-installed one so
				// scrubbing keeps working. Do NOT persist the rejected
				// set to disk.
				if errors.Is(err, redact.ErrTooManyPatterns) {
					logger.Printf("[error] refresh rejected: %v; keeping current set", err)
					continue
				}
				logger.Printf("[warn] %v", err)
			}
			setProvider.Set(set)
			_ = config.SaveRedactionSet(set)
			logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds",
				set.Version, len(set.Patterns), set.TTLSeconds)
		}
	}()

	// Seed the poll interval: cached agent-config (from a previous run's
	// fetch) wins over the --interval flag; a live fetch below (and the
	// hourly refresher) then wins over the cache once it lands.
	effectiveInterval := interval
	if cached, cerr := config.LoadAgentConfig(); cerr == nil && cached.PollIntervalSeconds > 0 {
		effectiveInterval = clampAgentConfigInterval(time.Duration(cached.PollIntervalSeconds) * time.Second)
	}
	intervalProvider := watcher.NewIntervalProvider(effectiveInterval)

	// Fetch the live agent-config synchronously (mirrors BootstrapRedactionSet's
	// synchronous initial fetch) so the first fetch's result doesn't race the
	// main loop's logger writes from a background goroutine. Fetch failure is
	// non-fatal: intervalProvider keeps the cache/flag-seeded value above.
	refreshAgentConfig(cmd.Context(), apiClient, key, intervalProvider, logger)

	// Background hourly refresher goroutine.
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-cmd.Context().Done():
				return
			case <-ticker.C:
				refreshAgentConfig(cmd.Context(), apiClient, key, intervalProvider, logger)
			}
		}
	}()

	// Build HTTPSink (replaces LogSink).
	httpSink := sink.NewHTTPSink(sink.HTTPSinkOpts{
		BaseURL:  cfg.APIBaseURL,
		Token:    key,
		DeviceID: cfg.DeviceID,
		Version:  version.Version,
		Mode:     mode,
		HTTP:     &http.Client{Timeout: 30 * time.Second},
		Retry:    sink.RetryPolicy{},
		Now:      time.Now,
		Logger:   logger,
	})

	// Construct chunker with real parser and live redaction-set provider.
	chunker := &watcher.Chunker{
		Parser:          parser.Dispatch,
		Mode:            mode,
		SetProv:         setProvider,
		GzipTargetBytes: 1 << 20,
		Log:             logger,
	}

	loop := watcher.NewLoop(watcher.LoopOpts{
		Sources: []watcher.Source{
			watcher.NewClaudeSource(claudeProjectsRoot()),
			watcher.NewCodexSource(codexSessionsRoot(), nil),
		},
		Tailer:           &watcher.Tailer{},
		Chunker:          chunker,
		Sink:             httpSink,
		Config:           cfg,
		State:            state,
		Resolver:         watcher.NewCWDResolver(nil),
		Log:              logger,
		Now:              time.Now,
		Interval:         interval,
		IntervalProvider: intervalProvider,
	})

	if once {
		if loopErr := loop.Tick(cmd.Context()); loopErr != nil {
			if errors.Is(loopErr, watcher.ErrPausedSkip) {
				// --once on a paused daemon is a deliberate no-op, not a failure.
				return nil
			}
			if ee := configSentinelExit(loopErr); ee != nil {
				return ee
			}
			if ee := fatalExitFor(loopErr); ee != nil {
				logger.Printf("[fatal] %v", loopErr)
				return ee
			}
			return loopErr
		}
		return nil
	}
	if loopErr := loop.Run(cmd.Context()); loopErr != nil {
		if ee := configSentinelExit(loopErr); ee != nil {
			return ee
		}
		if ee := fatalExitFor(loopErr); ee != nil {
			logger.Printf("[fatal] %v", loopErr)
			return ee
		}
		return loopErr
	}
	return nil
}

// configSentinelExit maps the three "uninstall-related" config sentinels
// (ErrUninstallInProgress / ErrConfigRemoved / ErrRootRemoved) to a clean
// exit 0. These sentinels mean uninstall is in progress or has cleaned the
// filesystem out from under the daemon — the correct response is to exit
// quietly so launchd / the operator's manual `caliber-agent run` invocation
// doesn't loop with non-zero exits. Spec §3.7 / R14-F1.
func configSentinelExit(err error) *ExitError {
	switch {
	case errors.Is(err, config.ErrUninstallInProgress),
		errors.Is(err, config.ErrConfigRemoved),
		errors.Is(err, config.ErrRootRemoved):
		return &ExitError{Code: 0, Err: err}
	}
	return nil
}

// codexSessionsRoot returns the default ~/.codex/sessions path.
// CALIBER_CODEX_SESSIONS env overrides for advanced/dev use (see agent/README.md).
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
