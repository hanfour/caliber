package cli

import "github.com/spf13/cobra"

func newRemovePathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove-path",
		Short: "Remove a project path from the allow-list (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("remove-path")
		},
	}
}
