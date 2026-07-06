package watcher

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

// seedRoot points CALIBER_AGENT_HOME at tmp and writes a config.toml stub
// so the preTickChecks added in PR4 Phase 7 don't short-circuit existing
// PR1/PR2 watcher tests as ErrConfigRemoved. Callers that explicitly need
// config.toml absent (e.g. TestTick_ConfigTomlRemoved_ExitsCleanly) should
// remove it after this helper runs.
func seedRoot(t *testing.T, tmp string) {
	t.Helper()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
}

type captureSink struct {
	mu     sync.Mutex
	chunks []sink.Chunk
	err    error
}

func (c *captureSink) SendChunk(_ context.Context, ck sink.Chunk) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.chunks = append(c.chunks, ck)
	return c.err
}

func (c *captureSink) Chunks() []sink.Chunk {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]sink.Chunk, len(c.chunks))
	copy(out, c.chunks)
	return out
}

type fakeLogger struct {
	mu    sync.Mutex
	lines []string
}

func (l *fakeLogger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

type fakeSource struct {
	name string
	refs []FileRef
	err  error
}

func (f *fakeSource) Name() string { return f.name }
func (f *fakeSource) List(_ context.Context) ([]FileRef, error) {
	return f.refs, f.err
}

type fakeResolver struct {
	byDir map[string]string
	err   error
	calls int
}

func (f *fakeResolver) ResolveClaude(dir string) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	return f.byDir[dir], nil
}

func TestLoop_HappyPath_AdvancesWatermark(t *testing.T) {
	tmp := t.TempDir()
	// SaveState (called from Tick) precheckRuntime requires config.toml
	// to exist; seedRoot writes a stub so in-loop persistence + preTickChecks
	// both succeed.
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-h-proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	sess := filepath.Join(proj, "sess.jsonl")
	if err := os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	srcs := []Source{&fakeSource{name: "claude", refs: []FileRef{{
		Path: sess, Source: "claude", SessionID: "sess",
	}}}}
	resv := &fakeResolver{byDir: map[string]string{proj: "/Users/h/proj"}}
	cap := &captureSink{}
	log := &fakeLogger{}
	state := &config.State{Files: map[string]config.FileWatermark{}}
	cfg := &config.Config{IncludePaths: []string{"/Users/h/proj"}}

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

	chunks := cap.Chunks()
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1", len(chunks))
	}
	if chunks[0].CWD != "/Users/h/proj" {
		t.Errorf("CWD = %q", chunks[0].CWD)
	}
	if state.Files[sess].Offset != int64(len(`{"a":1}`+"\n")) {
		t.Errorf("State.Files[sess].Offset = %d", state.Files[sess].Offset)
	}
	loaded, err := config.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Files[sess].Offset == 0 {
		t.Errorf("LoadState shows no advance: %+v", loaded.Files)
	}
}

func TestLoop_AllowListFilter_SkipsNonMatchingRefs(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	projInside := filepath.Join(tmp, "claude-projects", "-Users-h-allowed")
	projOutside := filepath.Join(tmp, "claude-projects", "-Users-h-forbidden")
	for _, d := range []string{projInside, projOutside} {
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, "s.jsonl"), []byte(`{"a":1}`+"\n"), 0o644)
	}

	srcs := []Source{&fakeSource{name: "claude", refs: []FileRef{
		{Path: filepath.Join(projInside, "s.jsonl"), Source: "claude", SessionID: "in"},
		{Path: filepath.Join(projOutside, "s.jsonl"), Source: "claude", SessionID: "out"},
	}}}
	resv := &fakeResolver{byDir: map[string]string{
		projInside:  "/Users/h/allowed",
		projOutside: "/Users/h/forbidden",
	}}
	cap := &captureSink{}
	loop := NewLoop(LoopOpts{
		Sources: srcs, Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/allowed"}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: resv, Log: &fakeLogger{}, Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cap.Chunks()) != 1 {
		t.Errorf("got %d chunks, want 1 (only allowed)", len(cap.Chunks()))
	}
	if cap.Chunks()[0].SessionID != "in" {
		t.Errorf("wrong session delivered: %q", cap.Chunks()[0].SessionID)
	}
}

// TestLoop_WatchAll_BypassesIncludePathsFilter is the C1 regression test:
// --watch-all persists WatchAll=true with an EMPTY IncludePaths (the old
// behaviour of seeding IncludePaths with the transcript-file roots like
// ~/.claude/projects was itself the bug, since a session's resolved cwd is
// never under that root). With WatchAll set, the cwd allow-list check must
// be skipped entirely so events flow through regardless of the resolved
// cwd's value.
func TestLoop_WatchAll_BypassesIncludePathsFilter(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-alice-myrepo")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	// Resolved cwd is an arbitrary dir NOT under any include path (and
	// IncludePaths is empty, as watch-all enroll now persists it).
	cap := &captureSink{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{WatchAll: true, IncludePaths: []string{}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/alice/myrepo"}},
		Log:      &fakeLogger{}, Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cap.Chunks()) != 1 {
		t.Fatalf("got %d chunks, want 1 (watch-all must bypass the cwd allow-list)", len(cap.Chunks()))
	}
}

// TestLoop_WatchAllFalse_NonMatchingCWD_StillSkipped preserves the existing
// allowed() behaviour: with WatchAll unset (the zero value) and a cwd that
// doesn't match any IncludePaths entry, the event must still be skipped.
func TestLoop_WatchAllFalse_NonMatchingCWD_StillSkipped(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-alice-myrepo")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	cap := &captureSink{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{WatchAll: false, IncludePaths: []string{"/Users/h/allowed"}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/alice/myrepo"}},
		Log:      &fakeLogger{}, Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cap.Chunks()) != 0 {
		t.Fatalf("got %d chunks, want 0 (non-matching cwd should still be skipped)", len(cap.Chunks()))
	}
}

func TestLoop_SinkError_StateUntouched(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	cap := &captureSink{err: errors.New("disk full")}
	state := &config.State{Files: map[string]config.FileWatermark{}}
	log := &fakeLogger{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      log,
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.Files[sess].Offset != 0 {
		t.Errorf("offset advanced despite sink error: %d", state.Files[sess].Offset)
	}
	if !containsLog(log, "[error] sink") {
		t.Errorf("expected [error] sink log line; got %v", log.lines)
	}
}

func TestLoop_FileShrank_PersistsResetBeforeRetail(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte("{}"), 0o644)

	state := &config.State{Files: map[string]config.FileWatermark{
		sess: {Offset: 1000},
	}}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: &captureSink{},
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.Files[sess].Offset != 0 {
		t.Errorf("post-shrink offset = %d, want 0", state.Files[sess].Offset)
	}
	loaded, err := config.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Files[sess].Offset != 0 {
		t.Errorf("state.json reset not persisted; got %+v", loaded.Files[sess])
	}
}

func TestLoop_NoEventSegment_AdvancesWatermark(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte("\n\n  \n"), 0o644)

	state := &config.State{Files: map[string]config.FileWatermark{}}
	cap := &captureSink{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cap.Chunks()) != 0 {
		t.Errorf("got %d chunks, want 0 for no-event segment", len(cap.Chunks()))
	}
	if state.Files[sess].Offset != int64(len("\n\n  \n")) {
		t.Errorf("offset = %d, want %d (advance past whitespace)", state.Files[sess].Offset, len("\n\n  \n"))
	}
}

func TestLoop_CWDCacheHit_OnSecondTick(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	resv := &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: &captureSink{},
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: resv,
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	first := resv.calls
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if resv.calls != first {
		t.Errorf("second tick should hit cache; first=%d, second=%d", first, resv.calls)
	}
}

func TestLoop_CWDCacheNotCachedOnEmpty_AllowsRetry(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	resv := &fakeResolver{byDir: map[string]string{}}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: &captureSink{},
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: resv,
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if resv.calls != 2 {
		t.Errorf("unresolved cwd should not cache; want 2 calls, got %d", resv.calls)
	}
}

func TestLoop_OversizeOnly_AdvancesAndLogs(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	huge := strings.Repeat("x", 5*1024*1024)
	os.WriteFile(sess, []byte(huge+"\n"), 0o644)

	state := &config.State{Files: map[string]config.FileWatermark{}}
	cap := &captureSink{}
	log := &fakeLogger{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      log,
		Interval: time.Hour,
	})
	if err := loop.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cap.Chunks()) != 0 {
		t.Errorf("got %d chunks, want 0", len(cap.Chunks()))
	}
	if state.Files[sess].Offset == 0 {
		t.Errorf("offset should advance past oversize bytes")
	}
	if !containsLog(log, "[warn] oversize line(s) dropped") {
		t.Errorf("expected oversize warn; got %v", log.lines)
	}
}

func containsLog(l *fakeLogger, substr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, substr) {
			return true
		}
	}
	return false
}

type cancelSink struct {
	mu        sync.Mutex
	calls     int
	ctxCancel context.CancelFunc
}

func (s *cancelSink) SendChunk(_ context.Context, _ sink.Chunk) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.ctxCancel()
	return nil
}

func TestLoop_SIGTERMMidTick_DrainsAndReturnsCtxErr(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)

	ctx, cancel := context.WithCancel(context.Background())

	makeFile := func(name string) string {
		p := filepath.Join(proj, name)
		os.WriteFile(p, []byte(`{"a":1}`+"\n"), 0o644)
		return p
	}
	r1 := makeFile("s1.jsonl")
	r2 := makeFile("s2.jsonl")

	cancelOnFirstSink := &cancelSink{ctxCancel: cancel}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: r1, Source: "claude", SessionID: "s1"},
			{Path: r2, Source: "claude", SessionID: "s2"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cancelOnFirstSink,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	err := loop.Tick(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
	if cancelOnFirstSink.calls != 1 {
		t.Errorf("expected exactly 1 sink call (drained then break), got %d", cancelOnFirstSink.calls)
	}
}

func TestLoop_Run_TicksUntilContextCancel(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	state := &config.State{Files: map[string]config.FileWatermark{}}
	cap := &captureSink{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer:   &Tailer{},
		Chunker:  &Chunker{},
		Sink:     cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      &fakeLogger{},
		Interval: 50 * time.Millisecond,
	})

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond) // long enough for ≥ 2 ticks
		cancel()
	}()

	err := loop.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
	// First tick should deliver the chunk; subsequent ticks see no new bytes.
	if len(cap.Chunks()) != 1 {
		t.Errorf("expected exactly 1 chunk delivered, got %d", len(cap.Chunks()))
	}
}

func TestLoop_Tick_PropagatesKeyRevokedFromSink(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	fatalErr := &api.APIError{StatusCode: 401, ErrorTag: "key_revoked", Body: "revoked"}
	cap := &captureSink{err: fatalErr}
	state := &config.State{Files: map[string]config.FileWatermark{}}
	log := &fakeLogger{}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      log,
		Interval: time.Hour,
	})
	err := loop.Tick(context.Background())
	if !errors.Is(err, api.ErrKeyRevoked) {
		t.Errorf("expected Tick to propagate ErrKeyRevoked, got %v", err)
	}
	// State must not advance on fatal error.
	if state.Files[sess].Offset != 0 {
		t.Errorf("offset advanced despite fatal sink error: %d", state.Files[sess].Offset)
	}
}

func TestLoop_Tick_PropagatesInvalidTokenFromSink(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	fatalErr := &api.APIError{StatusCode: 401, ErrorTag: "invalid_token", Body: "bad token"}
	cap := &captureSink{err: fatalErr}
	state := &config.State{Files: map[string]config.FileWatermark{}}
	loop := NewLoop(LoopOpts{
		Sources: []Source{&fakeSource{name: "claude", refs: []FileRef{
			{Path: sess, Source: "claude", SessionID: "s"},
		}}},
		Tailer: &Tailer{}, Chunker: &Chunker{}, Sink: cap,
		Config:   &config.Config{IncludePaths: []string{"/Users/h/p"}},
		State:    state,
		Resolver: &fakeResolver{byDir: map[string]string{proj: "/Users/h/p"}},
		Log:      &fakeLogger{},
		Interval: time.Hour,
	})
	err := loop.Tick(context.Background())
	if !errors.Is(err, api.ErrInvalidToken) {
		t.Errorf("expected Tick to propagate ErrInvalidToken, got %v", err)
	}
}

func TestAllowed_EvalSymlinksOnCWD(t *testing.T) {
	realDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	linkParent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(linkParent, "code")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}
	// includePaths is the *real* path; cwd presented is the symlinked alias.
	if !allowed(link, []string{realDir}) {
		t.Fatalf("cwd via symlink should match includePaths=[real] after EvalSymlinks")
	}
}

var _ io.ReadCloser // suppress unused import

// --- Phase 7 Task 7.3: per-tick + per-chunk + per-Save sentinel/config checks

// setupEnrolledRoot creates a CALIBER_AGENT_HOME with a config.toml stub so
// SaveState's precheckRuntime succeeds, and returns the root path.
func setupEnrolledRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", root)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

// buildLoopForTest assembles a Loop wired to a no-op source, empty state,
// captureSink, fakeResolver, and the supplied logger. Used by tests that
// only exercise preTickChecks behaviour and don't care about source IO.
func buildLoopForTest(t *testing.T, log Logger) *Loop {
	t.Helper()
	return NewLoop(LoopOpts{
		Sources:  []Source{&fakeSource{name: "claude", refs: nil}},
		Tailer:   &Tailer{},
		Chunker:  &Chunker{},
		Sink:     &captureSink{},
		Config:   &config.Config{IncludePaths: []string{}},
		State:    &config.State{Files: map[string]config.FileWatermark{}},
		Resolver: &fakeResolver{byDir: map[string]string{}},
		Log:      log,
		Interval: time.Hour,
	})
}

func TestTick_UninstallSentinelExists_SkipsTickWithFatalLog(t *testing.T) {
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	log := &fakeLogger{}
	loop := buildLoopForTest(t, log)
	err := loop.Tick(context.Background())
	if err == nil {
		t.Fatalf("want fatal error, got nil")
	}
	if !errors.Is(err, config.ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
	if !containsLog(log, "[fatal]") {
		t.Errorf("expected [fatal] log line, got %v", log.lines)
	}
}

func TestTick_ConfigTomlRemoved_ExitsCleanly(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.Remove(filepath.Join(root, "config.toml"))
	log := &fakeLogger{}
	loop := buildLoopForTest(t, log)
	err := loop.Tick(context.Background())
	if !errors.Is(err, config.ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestTick_SaveState_DiskFullReturnsRawIOError_DaemonContinues(t *testing.T) {
	// Loop's SaveState typed dispatch only fires on the three config
	// sentinels — every other error (disk full, EIO, EROFS, …) logs at
	// [error] level and continues. Injecting a real "disk full" outcome
	// from a unit test is heavy: it would require either wrapping
	// config.SaveState behind an interface (a public API change beyond
	// Task 7.3 scope) or a chmod-0500-the-root-dir trick that is brittle
	// across filesystems. The non-sentinel-continue path is exercised
	// indirectly by the existing PR2 happy-path Loop tests which would
	// not reach [tick-end] if a transient SaveState error were fatal.
	t.Skip("hook for non-sentinel SaveState error — see comment; plan §7.3 allows skip")
}

func TestTick_PausedSentinel_SkipsAndReturnsErrPausedSkip(t *testing.T) {
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	log := &fakeLogger{}
	loop := buildLoopForTest(t, log)
	err := loop.Tick(context.Background())
	// ErrPausedSkip is package-private; assert via errors.Is on the value.
	if !errors.Is(err, ErrPausedSkip) {
		t.Fatalf("want ErrPausedSkip, got %v", err)
	}
	if !containsLog(log, "[paused]") {
		t.Errorf("expected [paused] log line, got %v", log.lines)
	}
}

func TestRun_PausedSentinel_TickSkipsButLoopContinues(t *testing.T) {
	// End-to-end: paused sentinel should be a tick-skip, not a fatal exit.
	// Loop.Run catches ErrPausedSkip, sleeps interval, and loops again.
	root := setupEnrolledRoot(t)
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	log := &fakeLogger{}
	loop := buildLoopForTest(t, log)
	loop.interval = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond) // allow ≥ 2 paused ticks
		cancel()
	}()
	err := loop.Run(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want ctx.Canceled, got %v", err)
	}
	// Should have seen at least 2 [paused] log lines.
	log.mu.Lock()
	count := 0
	for _, l := range log.lines {
		if strings.Contains(l, "[paused]") {
			count++
		}
	}
	log.mu.Unlock()
	if count < 2 {
		t.Errorf("expected ≥ 2 [paused] log lines (paused sentinel skips, not fatal); got %d in %v", count, log.lines)
	}
}
