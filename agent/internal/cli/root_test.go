package cli

import (
	"bytes"
	"context"
	"os"
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

func TestExecuteWithVersionArgs(t *testing.T) {
	// Stash os.Args, restore on exit.
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"caliber-agent", "version"}
	code := Execute(context.Background())
	if code != 0 {
		t.Errorf("Execute returned %d, want 0", code)
	}
}

func TestExecuteWithUnknownCommandReturns1(t *testing.T) {
	origArgs := os.Args
	t.Cleanup(func() { os.Args = origArgs })
	os.Args = []string{"caliber-agent", "totally-not-a-command"}
	code := Execute(context.Background())
	if code != 1 {
		t.Errorf("Execute returned %d, want 1", code)
	}
}
