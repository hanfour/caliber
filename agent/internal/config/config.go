package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// ErrNotEnrolled is returned by Load when no config file exists.
var ErrNotEnrolled = errors.New("config: device not enrolled")

// Config is the on-disk shape of ~/.caliber-agent/config.toml. Spec §4.3.
type Config struct {
	DeviceID     string   `toml:"device_id"`
	Hostname     string   `toml:"hostname"`
	OS           string   `toml:"os"`
	APIBaseURL   string   `toml:"api_base_url"`
	Mode         string   `toml:"mode"`
	IncludePaths []string `toml:"include_paths"`
}

// Load reads and parses the config file. Returns ErrNotEnrolled if no file.
func Load() (*Config, error) {
	path := ConfigPath()
	bs, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotEnrolled
		}
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	c := &Config{}
	if err := toml.Unmarshal(bs, c); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	return c, nil
}

// Save writes the config atomically via tmp + rename. Permission is 0600
// because the file references the device identity. Parent dir created if
// missing.
func Save(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	root := RootDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", root, err)
	}
	final := ConfigPath()
	tmp, err := os.CreateTemp(root, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name()) // no-op if rename succeeded
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	if err := toml.NewEncoder(tmp).Encode(c); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close tmp: %w", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return fmt.Errorf("config: rename %s → %s: %w", filepath.Base(tmp.Name()), final, err)
	}
	return nil
}
