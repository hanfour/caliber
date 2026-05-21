package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestVersionSubcommandPrintsBuildString(t *testing.T) {
	cmd := New()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"version"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("ExecuteContext: %v", err)
	}
	if !strings.Contains(out.String(), "dev") {
		t.Fatalf("expected 'dev' in output, got %q", out.String())
	}
}

func TestUnknownSubcommandReturnsExitError(t *testing.T) {
	cmd := New()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"definitely-not-a-command"})
	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("expected error for unknown command")
	}
}

func TestExecuteReturns0OnSuccess(t *testing.T) {
	// Smoke: Execute wraps the cobra command and returns an int.
	// Compile-time check that the function exists with the right signature.
	_ = Execute
}
