package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// AgentConfig is the disk-cached form of GET /v1/agent-config. It drives
// the run loop's polling interval (watcher.IntervalProvider), refreshed
// hourly by the run.go refresher goroutine.
type AgentConfig struct {
	PollIntervalSeconds int64     `json:"poll_interval_seconds"`
	TTLSeconds          int64     `json:"ttl_seconds"`
	FetchedAt           time.Time `json:"fetched_at"`
}

// AgentConfigPath returns <RootDir>/agent-config.json.
func AgentConfigPath() string {
	return filepath.Join(RootDir(), "agent-config.json")
}

// IsExpired returns true when now > FetchedAt + TTLSeconds.
func (a *AgentConfig) IsExpired(now time.Time) bool {
	expiry := a.FetchedAt.Add(time.Duration(a.TTLSeconds) * time.Second)
	return now.After(expiry)
}

// LoadAgentConfig reads the cached agent-config from disk.
func LoadAgentConfig() (*AgentConfig, error) {
	bs, err := os.ReadFile(AgentConfigPath())
	if err != nil {
		return nil, fmt.Errorf("config: read agent-config: %w", err)
	}
	a := &AgentConfig{}
	if err := json.Unmarshal(bs, a); err != nil {
		return nil, fmt.Errorf("config: parse agent-config: %w", err)
	}
	return a, nil
}

// SaveAgentConfig writes atomically via tmp + rename. Perm 0o600.
// Runtime-only write: refuses to operate if precheckRuntime fails (root
// removed / uninstall in progress / config.toml missing). Never MkdirAlls.
func SaveAgentConfig(a *AgentConfig) error {
	if err := precheckRuntime(); err != nil {
		return err
	}
	root := RootDir()
	final := AgentConfigPath()
	tmp, err := os.CreateTemp(root, ".agent-config.json.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(a); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
