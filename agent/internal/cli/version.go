package cli

import (
	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the daemon build version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cmd.OutOrStdout().Write([]byte(version.String() + "\n"))
			return nil
		},
	}
}
