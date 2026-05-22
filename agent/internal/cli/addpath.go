package cli

import "github.com/spf13/cobra"

func newAddPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add-path",
		Short: "Add a project path to the allow-list (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("add-path")
		},
	}
}
