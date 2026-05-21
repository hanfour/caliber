package cli

import (
	"context"
	"errors"

	"github.com/spf13/cobra"
)

// PersistentFlags captures the root-level flags shared by every sub-command.
// Resolution order is documented in spec §4.6.
type PersistentFlags struct {
	ConfigDir  string // --config-dir
	APIBaseURL string // --api-base-url
	Verbose    bool   // -v / --verbose
}

var flags PersistentFlags

// New returns a fresh root *cobra.Command. Sub-commands are attached here.
// Returned as a value so tests can inject argv / stdin / stdout.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:           "caliber-agent",
		Short:         "Caliber daemon: ship LLM coding-session telemetry from local clients to caliber",
		SilenceUsage:  true,
		SilenceErrors: false,
	}
	cmd.PersistentFlags().StringVar(&flags.ConfigDir, "config-dir", "", "override CALIBER_AGENT_HOME")
	cmd.PersistentFlags().StringVar(&flags.APIBaseURL, "api-base-url", "", "override CALIBER_API_BASE_URL / config api_base_url")
	cmd.PersistentFlags().BoolVarP(&flags.Verbose, "verbose", "v", false, "print extra error context")

	cmd.AddCommand(newVersionCmd())
	return cmd
}

// Execute is the entry point called by cmd/caliber-agent/main.go. It returns
// the int exit code the process should use (spec §4.7).
func Execute(ctx context.Context) int {
	cmd := New()
	err := cmd.ExecuteContext(ctx)
	if err == nil {
		return 0
	}
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee.Code
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	return 1
}
