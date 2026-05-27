package config

import "errors"

// Sentinels distinguish "agent should exit" conditions (uninstall in progress
// or completed) from real IO failures. precheckRuntime + atomic-writer save
// functions return these; watcher.Loop and runRun dispatch on them.
var (
	// ErrRootRemoved — ~/.caliber-agent/ no longer exists (ordered_delete (i) past)
	ErrRootRemoved = errors.New("config: root directory removed")

	// ErrConfigRemoved — config.toml missing while root still exists
	// (ordered_delete (g) past, (i) not yet — invariant says sentinel is also gone)
	ErrConfigRemoved = errors.New("config: config.toml removed")

	// ErrUninstallInProgress — .uninstalling sentinel present (cleanup (c)-(g) running)
	ErrUninstallInProgress = errors.New("config: uninstall in progress")

	// ErrPartialUninstall — root exists but config.toml missing detected at enroll-time
	// first-write-aware precheck; spec §6.2 / §3.8
	ErrPartialUninstall = errors.New("config: partial uninstall detected (root exists, config.toml missing)")
)
