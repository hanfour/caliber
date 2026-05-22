package config

import "os"

// OpenAgentLog opens (or creates) ~/.caliber-agent/agent.log in
// append-only mode with 0600 permissions. The caller closes it.
// Spec §4.10.
//
// Rotation is intentionally out of scope for PR2 (Phase 3 ships
// log rotation). The file grows unbounded; operators can truncate
// with `: > agent.log` while the daemon runs because append-mode
// re-seeks to end on each write.
func OpenAgentLog() (*os.File, error) {
	path := LogPath()
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
}
