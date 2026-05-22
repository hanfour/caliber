package sink

import "context"

// Sink is the seam between watcher and ingest. PR3 swaps the impl.
type Sink interface {
	// SendChunk delivers c. On nil error the loop advances
	// state.Files[c.File].Offset to c.ToOffset and persists state.
	// On non-nil error the watermark stays put; the loop retries next tick.
	SendChunk(ctx context.Context, c Chunk) error
}
