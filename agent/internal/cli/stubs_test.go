package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// TestSetMode_Removed guards against accidental re-introduction of the
// `set-mode` subcommand. Mode changes are now done by editing config.toml
// directly + restarting `run` (PR3 OBS-2 startup allowlist still enforces
// valid modes). See spec §3.6 / plan Phase 12.
func TestSetMode_Removed(t *testing.T) {
	cmd := New()
	for _, sub := range cmd.Commands() {
		if sub.Name() == "set-mode" {
			t.Fatalf("set-mode subcommand must not be registered")
		}
	}
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--help"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("help: %v", err)
	}
	if strings.Contains(buf.String(), "set-mode") {
		t.Fatalf("help output still contains 'set-mode':\n%s", buf.String())
	}
}
