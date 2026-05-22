package cli

import "github.com/spf13/cobra"

func newSetModeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-mode",
		Short: "Set redaction mode (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("set-mode")
		},
	}
}
