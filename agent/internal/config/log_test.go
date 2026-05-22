package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAgentLog_CreatesAt0600(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("OpenAgentLog: %v", err)
	}
	defer f.Close()

	info, err := os.Stat(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

func TestOpenAgentLog_AppendsAcrossReopens(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f1, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if _, err := f1.WriteString("line-1\n"); err != nil {
		t.Fatal(err)
	}
	f1.Close()

	f2, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if _, err := f2.WriteString("line-2\n"); err != nil {
		t.Fatal(err)
	}
	f2.Close()

	bs, err := os.ReadFile(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(bs)
	if !strings.Contains(got, "line-1") || !strings.Contains(got, "line-2") {
		t.Errorf("expected both lines, got %q", got)
	}
}
