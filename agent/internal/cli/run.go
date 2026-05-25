package cli

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
	"github.com/hanfour/ai-dev-eval/agent/redact"
	"github.com/hanfour/ai-dev-eval/agent/redact/parser"
	"github.com/hanfour/ai-dev-eval/agent/sink"
	"github.com/hanfour/ai-dev-eval/agent/watcher"
)

func newRunCmd() *cobra.Command {
	var once bool
	var interval time.Duration
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the daemon main loop (foreground; launchd-managed in production)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runRun(cmd, once, interval)
		},
	}
	cmd.Flags().BoolVar(&once, "once", false, "run a single tick then exit (smoke-test affordance)")
	cmd.Flags().DurationVar(&interval, "interval", 60*time.Second, "polling interval (advanced; default 60s)")
	return cmd
}

func runRun(cmd *cobra.Command, once bool, interval time.Duration) error {
	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("device not enrolled; run `caliber-agent enroll` first: %w", err)}
	}
	key, err := keychain.Get(cfg.DeviceID)
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("device key missing from keychain; re-run `caliber-agent enroll`: %w", err)}
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
		if errors.Is(err, api.ErrKeyRevoked) {
			logger.Printf("[fatal] device key revoked by caliber server")
			logger.Printf("[fatal] Action: run `caliber-agent enroll <new-token>` to re-enroll this device")
			return &ExitError{Code: 0, Err: err}
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
				logger.Printf("[warn] %v", err)
			}
			setProvider.Set(set)
			_ = config.SaveRedactionSet(set)
			logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds",
				set.Version, len(set.Patterns), set.TTLSeconds)
		}
	}()

	// Build HTTPSink (replaces LogSink).
	httpSink := sink.NewHTTPSink(sink.HTTPSinkOpts{
		BaseURL:  cfg.APIBaseURL,
		Token:    key,
		DeviceID: cfg.DeviceID,
		Version:  version.Version,
		Mode:     redact.Mode(cfg.Mode),
		HTTP:     &http.Client{Timeout: 30 * time.Second},
		Retry:    sink.RetryPolicy{},
		Now:      time.Now,
		Logger:   logger,
	})

	// Construct chunker with real parser and live redaction-set provider.
	chunker := &watcher.Chunker{
		Parser:          parser.Dispatch,
		Mode:            redact.Mode(cfg.Mode),
		SetProv:         setProvider,
		GzipTargetBytes: 1 << 20,
		Log:             logger,
	}

	loop := watcher.NewLoop(watcher.LoopOpts{
		Sources: []watcher.Source{
			watcher.NewClaudeSource(claudeProjectsRoot()),
			watcher.NewCodexSource(codexSessionsRoot(), nil),
		},
		Tailer:   &watcher.Tailer{},
		Chunker:  chunker,
		Sink:     httpSink,
		Config:   cfg,
		State:    state,
		Resolver: watcher.NewCWDResolver(nil),
		Log:      logger,
		Now:      time.Now,
		Interval: interval,
	})

	if once {
		return loop.Tick(cmd.Context())
	}
	return loop.Run(cmd.Context())
}

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
