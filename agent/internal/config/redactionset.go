package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// RedactionSetPath returns <RootDir>/redaction-set.json.
func RedactionSetPath() string {
	return filepath.Join(RootDir(), "redaction-set.json")
}

// LoadRedactionSet reads the cached set from disk. The caller is responsible
// for calling RedactionSet.Compile() to rebuild the *regexp.Regexp values
// (encoding/json does not deserialise them).
//
// Returns redact.ErrNoRedactionSet if the file does not exist — caller
// falls back to fetch / default.
func LoadRedactionSet() (*redact.RedactionSet, error) {
	bs, err := os.ReadFile(RedactionSetPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, redact.ErrNoRedactionSet
		}
		return nil, fmt.Errorf("config: read redaction-set: %w", err)
	}
	s := &redact.RedactionSet{}
	if err := json.Unmarshal(bs, s); err != nil {
		return nil, fmt.Errorf("config: parse redaction-set: %w", err)
	}
	return s, nil
}

// SaveRedactionSet writes atomically via tmp + rename. Perm 0o600.
// Runtime-only write: refuses to operate if precheckRuntime fails (root
// removed / uninstall in progress / config.toml missing). Never MkdirAlls.
func SaveRedactionSet(s *redact.RedactionSet) error {
	if err := precheckRuntime(); err != nil {
		return err
	}
	root := RootDir()
	final := RedactionSetPath()
	tmp, err := os.CreateTemp(root, ".redaction-set.json.*")
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
	if err := enc.Encode(s); err != nil {
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
