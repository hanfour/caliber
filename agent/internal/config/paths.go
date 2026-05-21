package config

import (
	"os"
	"path/filepath"
)

// RootDir returns the root of caliber-agent state. CALIBER_AGENT_HOME wins
// if set; otherwise ~/.caliber-agent. Tests can override via t.Setenv.
func RootDir() string {
	if override := os.Getenv("CALIBER_AGENT_HOME"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// UserHomeDir only fails when both $HOME and the platform-specific
		// fallbacks are empty — extremely unlikely on darwin. Fall through
		// to a relative path so callers still see a deterministic error.
		home = "."
	}
	return filepath.Join(home, ".caliber-agent")
}

func ConfigPath() string { return filepath.Join(RootDir(), "config.toml") }
func StatePath() string  { return filepath.Join(RootDir(), "state.json") }
func LogPath() string    { return filepath.Join(RootDir(), "agent.log") }
