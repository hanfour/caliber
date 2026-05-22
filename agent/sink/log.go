package sink

import (
	"context"
	"fmt"
	"io"
	"time"
)

// LogSink is the PR2 stub Sink implementation. It writes ONE metadata-only
// line per chunk to the configured Writer. It never inspects Chunk.Events
// content — the regression test pins this (spec §4.2 privacy contract).
//
// PR3 replaces this with a real HTTP ingest client that gzips and POSTs
// to /v1/ingest. The Sink interface is the seam.
type LogSink struct {
	Writer io.Writer
	Now    func() time.Time // injectable; default time.Now
}

// NewLogSink constructs a LogSink. Now defaults to time.Now; tests
// override for deterministic timestamps.
func NewLogSink(w io.Writer) *LogSink {
	return &LogSink{Writer: w, Now: time.Now}
}

// SendChunk emits one [chunk] line and returns the writer error if any.
// On nil return the loop advances the watermark; on non-nil it does not
// (spec §6.2 — sink failure halts watermark advance for this ref this tick).
func (s *LogSink) SendChunk(ctx context.Context, c Chunk) error {
	if _, err := fmt.Fprintf(s.Writer,
		"%s [chunk] source=%s file=%s session=%s parent=%s cwd=%s events=%d bytes=%d-%d\n",
		s.Now().UTC().Format(time.RFC3339),
		c.Source, c.File, c.SessionID, c.ParentSessionID, c.CWD,
		len(c.Events), c.FromOffset, c.ToOffset,
	); err != nil {
		return fmt.Errorf("logsink: write: %w", err)
	}
	return nil
}
