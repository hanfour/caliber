// Package main is the caliber-agent entry point. All real logic lives in
// internal/cli; main is responsible only for signal handling, panic recovery,
// and translating the int exit code from cli.Execute into os.Exit.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/hanfour/ai-dev-eval/agent/internal/cli"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

func main() {
	os.Exit(run())
}

func run() (exitCode int) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr,
				"internal error: %v\nversion: %s\nPlease report at https://github.com/hanfour/caliber/issues\n",
				r, version.String())
			exitCode = 70
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return cli.Execute(ctx)
}
