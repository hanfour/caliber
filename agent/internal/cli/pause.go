package cli

import "github.com/spf13/cobra"

func newPauseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pause",
		Short: "Pause syncing (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("pause")
		},
	}
}
