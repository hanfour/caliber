//go:build !darwin

package cli

import (
	"errors"
	"testing"
)

// TestServiceStubsReturnNotImplemented verifies that on non-darwin
// platforms, install-service / uninstall-service RunE surfaces
// ExitNotImplemented (exit code 64, per exit.go / spec §4.6) rather than
// attempting any launchd behavior. Mirrors
// keychain/keychain_other_test.go's stub coverage.
func TestServiceStubsReturnNotImplemented(t *testing.T) {
	cases := []struct {
		name string
		cmd  func() error
	}{
		{"install-service", func() error {
			c := newInstallServiceCmd()
			return c.RunE(c, nil)
		}},
		{"uninstall-service", func() error {
			c := newUninstallServiceCmd()
			return c.RunE(c, nil)
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cmd()
			var ee *ExitError
			if !errors.As(err, &ee) {
				t.Fatalf("expected *ExitError, got %v (%T)", err, err)
			}
			if ee.Code != 64 {
				t.Fatalf("Code = %d, want 64", ee.Code)
			}
		})
	}
}
