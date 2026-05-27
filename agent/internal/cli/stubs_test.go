package cli

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func runCmd(t *testing.T, args ...string) error {
	t.Helper()
	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs(args)
	return cmd.ExecuteContext(context.Background())
}

func TestEachStubReturnsExit64(t *testing.T) {
	commands := []string{"set-mode", "uninstall"}
	for _, name := range commands {
		t.Run(name, func(t *testing.T) {
			err := runCmd(t, name)
			if err == nil {
				t.Fatalf("%s: expected error", name)
			}
			var ee *ExitError
			if !errors.As(err, &ee) {
				t.Fatalf("%s: expected *ExitError, got %T", name, err)
			}
			if ee.Code != 64 {
				t.Errorf("%s: code = %d, want 64", name, ee.Code)
			}
		})
	}
}
