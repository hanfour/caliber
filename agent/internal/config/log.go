package config

import (
	"fmt"
	"io"
	"os"
	"time"
)

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

// RFCLogger formats every line as "<UTC-RFC3339> <printf-rendered>\n".
//
// Why a custom logger instead of stdlib log.New(...):
//
//	log.LstdFlags|log.LUTC emits "YYYY/MM/DD HH:MM:SS" which violates the
//	§5 frozen external contract requiring UTC-RFC3339 line format. This
//	tiny wrapper is the simplest way to comply without pulling in a
//	logging library.
//
// The Printf signature matches watcher.Logger so RFCLogger satisfies
// that interface directly. Format strings must NOT include a trailing
// newline — Printf appends one.
type RFCLogger struct {
	Target io.Writer
	Now    func() time.Time // injectable; default time.Now
}

// NewRFCLogger constructs an RFCLogger writing to target.
func NewRFCLogger(target io.Writer) *RFCLogger {
	return &RFCLogger{Target: target, Now: time.Now}
}

// Printf renders the line and writes one timestamped row.
func (l *RFCLogger) Printf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Fprintf(l.Target, "%s %s\n", l.Now().UTC().Format(time.RFC3339), line)
}
