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

// TestRoot_ApiBaseURLFlag_OnlyOnEnroll guards spec §6.4: --api-base-url is a
// local flag on `enroll` only. It must not be promoted to a persistent root
// flag (runtime commands read api_base_url from config.toml; surfacing the
// flag elsewhere would mislead users into thinking other subcommands honor
// it). See plan Phase 12 Task 12.2.
func TestRoot_ApiBaseURLFlag_OnlyOnEnroll(t *testing.T) {
	cmd := New()
	if f := cmd.PersistentFlags().Lookup("api-base-url"); f != nil {
		t.Fatalf("--api-base-url must NOT be a PersistentFlag, found %+v", f)
	}
	for _, sub := range cmd.Commands() {
		if sub.Name() == "enroll" {
			if f := sub.LocalFlags().Lookup("api-base-url"); f == nil {
				t.Fatalf("enroll must have --api-base-url as local flag")
			}
			return
		}
	}
	t.Fatal("enroll subcommand not found")
}
