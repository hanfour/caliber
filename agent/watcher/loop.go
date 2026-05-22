package watcher

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

// Logger is the contract Loop needs. config.RFCLogger satisfies it.
type Logger interface {
	Printf(format string, args ...any)
}

// ResolverIface lets tests inject a fake resolver. *CWDResolver satisfies it.
type ResolverIface interface {
	ResolveClaude(claudeProjDir string) (string, error)
}

// LoopOpts is the constructor argument.
type LoopOpts struct {
	Sources  []Source
	Tailer   *Tailer
	Chunker  *Chunker
	Sink     sink.Sink
	Config   *config.Config
	State    *config.State
	Resolver ResolverIface
	Log      Logger
	Now      func() time.Time
	Interval time.Duration
}

// Loop is the orchestrator that wires sources × tail × chunker × sink.
type Loop struct {
	sources  []Source
	tailer   *Tailer
	chunker  *Chunker
	sink     sink.Sink
	config   *config.Config
	state    *config.State
	resolver ResolverIface
	log      Logger
	now      func() time.Time
	interval time.Duration
	cwdCache map[string]string
}

// NewLoop constructs a Loop from opts.
func NewLoop(opts LoopOpts) *Loop {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Resolver == nil {
		opts.Resolver = NewCWDResolver(nil)
	}
	return &Loop{
		sources:  opts.Sources,
		tailer:   opts.Tailer,
		chunker:  opts.Chunker,
		sink:     opts.Sink,
		config:   opts.Config,
		state:    opts.State,
		resolver: opts.Resolver,
		log:      opts.Log,
		now:      opts.Now,
		interval: opts.Interval,
		cwdCache: make(map[string]string),
	}
}

// Run drives the loop until ctx is cancelled, sleeping interval between ticks.
func (l *Loop) Run(ctx context.Context) error {
	for {
		if err := l.Tick(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(l.interval):
		}
	}
}

// Tick runs one poll cycle over all sources. Per-ref and per-chunk errors are
// caught, logged, and the loop continues. Tick only returns ctx.Err() on
// cancellation.
func (l *Loop) Tick(ctx context.Context) error {
	tickStart := l.now()
	var totalRefs, totalChunks, totalErrors int

SOURCELOOP:
	for _, src := range l.sources {
		refs, err := src.List(ctx)
		if err != nil {
			l.log.Printf("[warn] source %s unavailable: %v", src.Name(), err)
			totalErrors++
			continue
		}
		for _, ref := range refs {
			if ctx.Err() != nil {
				break SOURCELOOP
			}
			totalRefs++

			cwd, err := l.resolveCWDForRef(ref)
			if err != nil {
				l.log.Printf("[error] resolve cwd %s: %v", ref.Path, err)
				totalErrors++
				continue
			}
			if cwd == "" {
				l.log.Printf("[debug] cwd unresolved: %s", ref.Path)
				continue
			}
			if !allowed(cwd, l.config.IncludePaths) {
				continue
			}

			wm := l.state.Files[ref.Path]
			tr, terr := l.tailer.Read(ref.Path, wm.Offset)
			if errors.Is(terr, ErrFileGone) {
				l.log.Printf("[warn] file gone: %s", ref.Path)
				continue
			}
			if errors.Is(terr, ErrFileShrank) {
				l.log.Printf("[warn] file shrank from %d, resetting offset to 0: %s", wm.Offset, ref.Path)
				// Persist offset 0 BEFORE re-tailing to prevent infinite loop on shrink-to-empty.
				l.state.Files[ref.Path] = config.FileWatermark{Offset: 0, LastSync: l.now()}
				if saveErr := config.SaveState(l.state); saveErr != nil {
					l.log.Printf("[error] save state (shrink reset): %v", saveErr)
				}
				tr, terr = l.tailer.Read(ref.Path, 0)
				if terr != nil {
					l.log.Printf("[error] tail after reset: %v", terr)
					totalErrors++
					continue
				}
			}
			if terr != nil {
				l.log.Printf("[error] tail: %v", terr)
				totalErrors++
				continue
			}

			if tr.OversizeDropped > 0 {
				l.log.Printf("[warn] oversize line(s) dropped (ref=%s count=%d)", ref.Path, tr.OversizeDropped)
			}
			if tr.TickBudgetHit {
				l.log.Printf("[warn] per-tick byte budget hit, resuming next tick (ref=%s consumed=%d)", ref.Path, tr.ToOffset-wm.Offset)
			}

			// No new bytes consumed.
			if tr.ToOffset == wm.Offset {
				continue
			}

			chunks := l.chunker.Split(ref, tr, cwd)
			if len(chunks) == 0 && tr.ToOffset > wm.Offset {
				// No-event consumed segment: whitespace / oversize-only bytes.
				// Advance watermark so we don't re-read the same bytes.
				l.state.Files[ref.Path] = config.FileWatermark{Offset: tr.ToOffset, LastSync: l.now()}
				if saveErr := config.SaveState(l.state); saveErr != nil {
					l.log.Printf("[error] save state (no-event segment): %v", saveErr)
				}
				continue
			}

			for _, c := range chunks {
				if ctx.Err() != nil {
					break SOURCELOOP
				}
				if sendErr := l.sink.SendChunk(ctx, c); sendErr != nil {
					l.log.Printf("[error] sink: %v", sendErr)
					totalErrors++
					break
				}
				totalChunks++
				l.state.Files[c.File] = config.FileWatermark{Offset: c.ToOffset, LastSync: l.now()}
				if saveErr := config.SaveState(l.state); saveErr != nil {
					l.log.Printf("[error] save state: %v", saveErr)
				}
			}
		}
	}

	l.log.Printf("[tick-end] sources=%d refs=%d chunks=%d errors=%d duration=%s",
		len(l.sources), totalRefs, totalChunks, totalErrors, l.now().Sub(tickStart))

	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

// resolveCWDForRef resolves the working directory for ref. Empty resolutions
// and errors are NOT cached so they can be retried on the next tick.
func (l *Loop) resolveCWDForRef(ref FileRef) (string, error) {
	if l.cwdCache == nil {
		l.cwdCache = make(map[string]string)
	}
	// Some sources (codex) populate CWD directly.
	if ref.CWD != "" {
		l.cwdCache[ref.Path] = ref.CWD
		return ref.CWD, nil
	}
	claudeDir := filepath.Dir(ref.Path)
	if ref.Source == "claude-subagent" {
		claudeDir = filepath.Dir(filepath.Dir(claudeDir))
	}
	if cached, ok := l.cwdCache[claudeDir]; ok && cached != "" {
		return cached, nil
	}
	cwd, err := l.resolver.ResolveClaude(claudeDir)
	if err != nil {
		return "", err
	}
	// Only cache non-empty resolutions.
	if cwd != "" {
		l.cwdCache[claudeDir] = cwd
	}
	return cwd, nil
}

// allowed reports whether cwd is within any of the include paths.
func allowed(cwd string, includes []string) bool {
	for _, inc := range includes {
		if cwd == inc || strings.HasPrefix(cwd, inc+"/") {
			return true
		}
	}
	return false
}
