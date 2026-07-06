package watcher

import (
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestIntervalProvider_CurrentReturnsInitial(t *testing.T) {
	p := NewIntervalProvider(60 * time.Second)
	if got := p.Current(); got != 60*time.Second {
		t.Errorf("Current() = %v, want 60s", got)
	}
}

func TestIntervalProvider_SetUpdatesCurrent(t *testing.T) {
	p := NewIntervalProvider(60 * time.Second)
	p.Set(300 * time.Second)
	if got := p.Current(); got != 300*time.Second {
		t.Errorf("Current() after Set = %v, want 300s", got)
	}
}

// TestNewLoop_ReadsIntervalFromProvider verifies NewLoop stores the
// IntervalProvider passed via LoopOpts so Loop.Run can read Current() from
// it each tick instead of the fixed Interval field. A full loop-timing
// test (asserting Run actually sleeps the provider's duration) would be
// flaky under CI scheduling jitter, so this only asserts the wiring.
func TestNewLoop_ReadsIntervalFromProvider(t *testing.T) {
	tmp := t.TempDir()
	seedRoot(t, tmp)

	prov := NewIntervalProvider(time.Millisecond)
	src := &fakeSource{name: "s"}
	l := NewLoop(LoopOpts{
		Sources:          []Source{src},
		Tailer:           &Tailer{},
		Chunker:          &Chunker{Log: &fakeLogger{}},
		Sink:             &captureSink{},
		Config:           &config.Config{},
		State:            &config.State{Files: map[string]config.FileWatermark{}},
		Log:              &fakeLogger{},
		Now:              time.Now,
		Interval:         time.Hour, // fallback; provider should win
		IntervalProvider: prov,
	})
	if l.intervalProvider == nil {
		t.Fatal("NewLoop did not store IntervalProvider")
	}
	if got := l.intervalProvider.Current(); got != time.Millisecond {
		t.Errorf("stored provider Current() = %v, want 1ms", got)
	}
}
