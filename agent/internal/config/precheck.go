package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// precheckRuntime is called by SaveState / SaveRedactionSet / SaveConfig (runtime)
// before they touch the disk. Check order is reverse-aligned with ordered_delete
// (i)→(h)→(g) so that the most-recently-occurred state is detected first:
//
//  1. stat root        — ErrNotExist → ErrRootRemoved (ordered_delete (i) past)
//  2. stat .uninstalling — exists or non-ErrNotExist → ErrUninstallInProgress (fail-closed)
//  3. stat config.toml — ErrNotExist → ErrConfigRemoved (invariant: sentinel must also be gone,
//     but check anyway because precheck can race with ordered_delete (g)→(h))
//
// Returns nil iff the daemon is safe to perform a runtime write.
func precheckRuntime() error {
	root := RootDir()

	// 1. root must exist
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrRootRemoved
		}
		// transient stat error — retry-friendly: don't block writes
	}

	// 2. sentinel — fail-closed
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
		return ErrUninstallInProgress
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w (sentinel stat failed: %v; fail-closed)", ErrUninstallInProgress, err)
	}

	// 3. config.toml — pure ErrNotExist
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrConfigRemoved
		}
		// transient stat error — retry-friendly
	}
	return nil
}
