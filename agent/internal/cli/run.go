package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
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
	if _, err := keychain.Get(cfg.DeviceID); err != nil {
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

	loop := watcher.NewLoop(watcher.LoopOpts{
		Sources: []watcher.Source{
			watcher.NewClaudeSource(claudeProjectsRoot()),
			watcher.NewCodexSource(codexSessionsRoot(), nil),
		},
		Tailer:   &watcher.Tailer{},
		Chunker:  &watcher.Chunker{},
		Sink:     sink.NewLogSink(logFile),
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
	err = loop.Run(cmd.Context())
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
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
