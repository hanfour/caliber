package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestBackfillFilter(t *testing.T) {
	cutoff := time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC) // ~90d before a 2026-07-03 enroll
	old := FileRef{Path: "/x/old.jsonl", ModTime: cutoff.Add(-24 * time.Hour)}
	fresh := FileRef{Path: "/x/new.jsonl", ModTime: cutoff.Add(24 * time.Hour)}

	if !skipForBackfill(old, cutoff, map[string]bool{}) {
		t.Error("old file (before cutoff, unwatched) should be skipped")
	}
	if skipForBackfill(fresh, cutoff, map[string]bool{}) {
		t.Error("fresh file should not be skipped")
	}
	// already-watched old file is NOT skipped (we keep tailing what we started)
	if skipForBackfill(old, cutoff, map[string]bool{"/x/old.jsonl": true}) {
		t.Error("already-watched old file should not be skipped")
	}
	// zero cutoff (legacy enroll) disables filtering
	if skipForBackfill(old, time.Time{}, map[string]bool{}) {
		t.Error("zero cutoff should disable backfill filtering")
	}
}

// TestLoop_Tick_SkipsOldUnwatchedFile is an integration-level check that the
// wiring in Tick actually calls skipForBackfill: an old, never-before-seen
// file must produce zero chunks and leave the watermark map untouched, even
// though its content would otherwise tail cleanly.
func TestLoop_Tick_SkipsOldUnwatchedFile(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-h-proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	sess := filepath.Join(proj, "old.jsonl")
	if err := os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Now()
	oldModTime := cutoff.Add(-24 * time.Hour)

	srcs := []Source{&fakeSource{name: "claude", refs: []FileRef{{
		Path: sess, Source: "claude", SessionID: "old", ModTime: oldModTime,
	}}}}
	resv := &fakeResolver{byDir: map[string]string{proj: "/Users/h/proj"}}
	cap := &captureSink{}
	log := &fakeLogger{}
	state := &config.State{Files: map[string]config.FileWatermark{}}
	cfg := &config.Config{IncludePaths: []string{"/Users/h/proj"}, BackfillCutoff: cutoff}

	loop := NewLoop(LoopOpts{
		Sources:  srcs,
		Tailer:   &Tailer{},
		Chunker:  &Chunker{},
		Sink:     cap,
		Config:   cfg,
		State:    state,
		Resolver: resv,
		Log:      log,
		Now:      func() time.Time { return time.Unix(0, 0).UTC() },
		Interval: 100 * time.Millisecond,
	})

	if err := loop.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	if len(cap.Chunks()) != 0 {
		t.Fatalf("got %d chunks, want 0 (old file should be skipped at discovery)", len(cap.Chunks()))
	}
	if _, tracked := state.Files[sess]; tracked {
		t.Errorf("state.Files should not track a backfill-skipped file, got %+v", state.Files[sess])
	}
}

// TestLoop_Tick_TailsAlreadyWatchedOldFile confirms that a file already
// present in the watermark map is tailed normally even though its mtime
// predates the cutoff — we never stop tailing something we've already
// started (spec Task 6 constraint).
func TestLoop_Tick_TailsAlreadyWatchedOldFile(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-h-proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	sess := filepath.Join(proj, "old.jsonl")
	content := `{"a":1}` + "\n"
	if err := os.WriteFile(sess, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Now()
	oldModTime := cutoff.Add(-24 * time.Hour)

	srcs := []Source{&fakeSource{name: "claude", refs: []FileRef{{
		Path: sess, Source: "claude", SessionID: "old", ModTime: oldModTime,
	}}}}
	resv := &fakeResolver{byDir: map[string]string{proj: "/Users/h/proj"}}
	cap := &captureSink{}
	log := &fakeLogger{}
	// Pre-seed the watermark so the file is already-tracked (offset 0, never
	// yet read) — this must still be tailed despite the old mtime.
	state := &config.State{Files: map[string]config.FileWatermark{
		sess: {Offset: 0},
	}}
	cfg := &config.Config{IncludePaths: []string{"/Users/h/proj"}, BackfillCutoff: cutoff}

	loop := NewLoop(LoopOpts{
		Sources:  srcs,
		Tailer:   &Tailer{},
		Chunker:  &Chunker{},
		Sink:     cap,
		Config:   cfg,
		State:    state,
		Resolver: resv,
		Log:      log,
		Now:      func() time.Time { return time.Unix(0, 0).UTC() },
		Interval: 100 * time.Millisecond,
	})

	if err := loop.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	if len(cap.Chunks()) != 1 {
		t.Fatalf("got %d chunks, want 1 (already-watched file must still be tailed)", len(cap.Chunks()))
	}
}
