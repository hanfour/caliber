package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadAgentConfig_MissingReturnsError(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := LoadAgentConfig()
	if err == nil {
		t.Fatal("want error when agent-config.json is missing")
	}
}

func TestAgentConfigSaveLoadRoundTrip(t *testing.T) {
	tmp := setupRoot(t)
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	orig := &AgentConfig{
		PollIntervalSeconds: 300,
		TTLSeconds:          3600,
		FetchedAt:           time.Date(2026, 5, 23, 0, 0, 0, 0, time.UTC),
	}
	if err := SaveAgentConfig(orig); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "agent-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := LoadAgentConfig()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.PollIntervalSeconds != 300 || got.TTLSeconds != 3600 {
		t.Errorf("got = %+v", got)
	}
}

func TestAgentConfig_IsExpired(t *testing.T) {
	a := &AgentConfig{
		FetchedAt:  time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		TTLSeconds: 60,
	}
	if a.IsExpired(time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)) {
		t.Error("30s in should not be expired with 60s ttl")
	}
	if !a.IsExpired(time.Date(2026, 1, 1, 0, 1, 1, 0, time.UTC)) {
		t.Error("61s in should be expired with 60s ttl")
	}
}

func TestAgentConfigPath_HonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/x")
	if got := AgentConfigPath(); got != "/x/agent-config.json" {
		t.Errorf("got %q", got)
	}
}

func TestSaveAgentConfig_RefusesWhenRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	if err := SaveAgentConfig(&AgentConfig{}); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestSaveIsAtomic_AgentConfig_NoLeftoverTmp(t *testing.T) {
	tmp := setupRoot(t)
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveAgentConfig(&AgentConfig{PollIntervalSeconds: 60, TTLSeconds: 1}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(tmp)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}
