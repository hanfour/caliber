package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
)

// State is the persisted watcher watermark map. PR1 ships only the
// skeleton — the watcher PR populates Files.
type State struct {
	Files map[string]FileWatermark `json:"files"`
}

type FileWatermark struct {
	Offset   int64     `json:"offset"`
	LastSync time.Time `json:"last_sync"`
}

func LoadState() (*State, error) {
	path := StatePath()
	bs, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &State{Files: map[string]FileWatermark{}}, nil
		}
		return nil, fmt.Errorf("state: read %s: %w", path, err)
	}
	s := &State{}
	if err := json.Unmarshal(bs, s); err != nil {
		return nil, fmt.Errorf("state: parse %s: %w", path, err)
	}
	if s.Files == nil {
		s.Files = map[string]FileWatermark{}
	}
	return s, nil
}

func SaveState(s *State) error {
	if s.Files == nil {
		s.Files = map[string]FileWatermark{}
	}
	root := RootDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("state: mkdir %s: %w", root, err)
	}
	final := StatePath()
	tmp, err := os.CreateTemp(root, ".state.json.*")
	if err != nil {
		return fmt.Errorf("state: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("state: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return fmt.Errorf("state: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("state: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("state: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
