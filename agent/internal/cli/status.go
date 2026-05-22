package cli

import "github.com/spf13/cobra"

func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show daemon status (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("status")
		},
	}
}
