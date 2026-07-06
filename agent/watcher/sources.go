// Package watcher polls source transcript directories, tails new bytes,
// chunks them, and delivers chunks to a Sink. The package is structured
// so PR3 can swap the sink implementation without touching the tailer
// or the source-discovery code.
package watcher

import (
	"context"
	"time"
)

// FileRef is one transcript file discovered by a Source. CWD is
// populated by sources that know the cwd cheaply (codex via
// session_meta); claude leaves it empty and the loop calls
// CWDResolver. See spec §4.3.
type FileRef struct {
	Path            string // absolute
	Source          string // "claude" | "claude-subagent" | "codex"
	SessionID       string
	ParentSessionID string    // empty unless Source == "claude-subagent"
	CWD             string    // empty for claude (resolver fills); cheap for codex
	ModTime         time.Time // file mtime, for backfill cutoff filtering
}

// Source enumerates files under one root. It does not open them for
// content beyond what the source layout requires for cwd extraction
// (codex reads the first line; claude does not open files in List).
type Source interface {
	Name() string // for logs
	List(ctx context.Context) ([]FileRef, error)
}
