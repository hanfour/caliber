package config

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/BurntSushi/toml"
)

// ErrNotEnrolled is returned by Load when no config file exists.
var ErrNotEnrolled = errors.New("config: device not enrolled")

// Config is the on-disk shape of ~/.caliber-agent/config.toml. Spec §4.3.
type Config struct {
	DeviceID          string   `toml:"device_id"`
	Hostname          string   `toml:"hostname"`
	OS                string   `toml:"os"`
	APIBaseURL        string   `toml:"api_base_url"`
	Mode              string   `toml:"mode"`
	IncludePaths      []string `toml:"include_paths"`
	InsecureTransport bool     `toml:"insecure_transport"`
	// KeychainPath, when set, points the macOS `security` CLI at a custom
	// keychain file instead of the login keychain. Enables SSH/headless
	// daemon operation: the login keychain can't be unlocked from a
	// non-GUI session, but a dedicated keychain unlocked once via
	// `security unlock-keychain` works (#168). Empty = login keychain.
	KeychainPath string `toml:"keychain_path,omitempty"`
	// BackfillCutoff, when set, is the fixed anchor (enrolled-at minus N days)
	// below which newly-discovered transcript files are skipped at discovery
	// time. It is persisted once at enroll — NOT rolling — so the cutoff
	// stays pinned to the original enroll date across restarts. Zero value
	// (legacy configs written before this field existed, or --backfill-days
	// 0) disables the filter entirely (spec Task 6).
	BackfillCutoff time.Time `toml:"backfill_cutoff,omitempty"`
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

// SaveConfigInitial writes config.toml during enroll. It is the only save
// function permitted to MkdirAll the root, but it still performs first-
// write-aware safety checks (R19/R20) when root already exists, to catch
// the enroll preflight → SaveConfigInitial TOCTOU window:
//
//   - root exists + sentinel present → ErrUninstallInProgress
//   - root exists + config.toml missing (no sentinel) → ErrPartialUninstall
//   - root absent (clean first enroll) or root + config.toml present (re-enroll)
//     → MkdirAll + atomic write
func SaveConfigInitial(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	root := RootDir()
	if info, err := os.Stat(root); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("config: %s exists but is not a directory", root)
		}
		// root exists — re-run both enroll preflight checks
		if _, sErr := os.Stat(filepath.Join(root, ".uninstalling")); sErr == nil {
			return ErrUninstallInProgress
		} else if !errors.Is(sErr, fs.ErrNotExist) {
			return fmt.Errorf("%w (sentinel stat: %v; fail-closed)", ErrUninstallInProgress, sErr)
		}
		if _, cErr := os.Stat(filepath.Join(root, "config.toml")); errors.Is(cErr, fs.ErrNotExist) {
			return ErrPartialUninstall
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("config: stat root: %w", err)
	}
	// root absent (first enroll) or root + config.toml present (re-enroll) — safe to MkdirAll + write.
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", root, err)
	}
	return writeConfigAtomically(c, root)
}

// SaveConfig writes config.toml during runtime mutations (add-path / remove-path).
// It enforces precheckRuntime and never MkdirAlls.
func SaveConfig(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	if err := precheckRuntime(); err != nil {
		return err
	}
	return writeConfigAtomically(c, RootDir())
}

// writeConfigAtomically is the shared tmp+rename body. Pulled out so both
// SaveConfig and SaveConfigInitial share the same encoder/chmod/fsync logic.
func writeConfigAtomically(c *Config, root string) error {
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

// ValidateAPIBaseURL enforces a strict scheme whitelist:
//   - https://   always allowed
//   - http://    allowed iff allowInsecure
//   - everything else (ftp/file/gopher/...) always rejected
func ValidateAPIBaseURL(raw string, allowInsecure bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("invalid api_base_url: %q", raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if allowInsecure {
			return nil
		}
		return fmt.Errorf("api_base_url uses http://; pass --insecure to allow (dev/local only)")
	default:
		return fmt.Errorf("api_base_url must be https:// (got scheme %q)", u.Scheme)
	}
}
