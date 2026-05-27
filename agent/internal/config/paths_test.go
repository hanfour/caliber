package config

import (
	"path/filepath"
	"testing"
)

func TestRootDirHonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/custom/path")
	if got := RootDir(); got != "/custom/path" {
		t.Fatalf("RootDir() = %q, want %q", got, "/custom/path")
	}
}

func TestRootDirFallsBackToHome(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", "")
	t.Setenv("HOME", tmp)
	want := filepath.Join(tmp, ".caliber-agent")
	if got := RootDir(); got != want {
		t.Fatalf("RootDir() = %q, want %q", got, want)
	}
}

func TestDerivedPaths(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/x")
	cases := map[string]string{
		"ConfigPath": ConfigPath(),
		"StatePath":  StatePath(),
		"LogPath":    LogPath(),
	}
	wants := map[string]string{
		"ConfigPath": "/x/config.toml",
		"StatePath":  "/x/state.json",
		"LogPath":    "/x/agent.log",
	}
	for k, got := range cases {
		if got != wants[k] {
			t.Errorf("%s = %q, want %q", k, got, wants[k])
		}
	}
}

func TestNewPathHelpers(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/ca-test")
	cases := []struct {
		name, want string
		fn         func() string
	}{
		{"sentinel", "/tmp/ca-test/.uninstalling", UninstallSentinelPath},
		{"lock", "/tmp/ca-test/.lock", LockPath},
		{"paused", "/tmp/ca-test/paused", PausedPath},
	}
	for _, c := range cases {
		if got := c.fn(); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
