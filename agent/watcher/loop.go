package watcher

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

// ErrPausedSkip is returned by preTickChecks when the `paused` sentinel is
// present. Loop.Run catches it and continues to the next interval instead of
// treating it as a fatal return — paused is a user-requested suspension, not
// an uninstall or config-removal condition.
var ErrPausedSkip = errors.New("watcher: paused sentinel present; skipping tick")

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
//
// ErrPausedSkip from Tick is NOT a fatal return — the paused sentinel is a
// user-requested suspension and Run continues to the next interval. The three
// config sentinels (ErrUninstallInProgress / ErrConfigRemoved / ErrRootRemoved)
// ARE fatal and propagate up to runRun where they map to ExitError{Code:0}.
func (l *Loop) Run(ctx context.Context) error {
	for {
		err := l.Tick(ctx)
		if err != nil && !errors.Is(err, ErrPausedSkip) {
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
// caught, logged, and the loop continues. Tick returns ctx.Err() on
// cancellation, or one of the config sentinels (ErrUninstallInProgress /
// ErrConfigRemoved / ErrRootRemoved) or ErrPausedSkip when preTickChecks /
// per-chunk re-checks fire. Run() and runRun decide how to react.
func (l *Loop) Tick(ctx context.Context) error {
	if err := l.preTickChecks(); err != nil {
		if errors.Is(err, ErrPausedSkip) {
			// User-requested suspension. Loop.Run() will continue.
			return err
		}
		// Anything else is a fatal stop-condition — log and propagate.
		l.log.Printf("[fatal] %v", err)
		return err
	}
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
				if fatal := l.saveStateOrFatal("shrink reset"); fatal != nil {
					return fatal
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
				if fatal := l.saveStateOrFatal("no-event segment"); fatal != nil {
					return fatal
				}
				continue
			}

			for _, c := range chunks {
				if ctx.Err() != nil {
					break SOURCELOOP
				}
				// Per-SendChunk sentinel + config re-check (spec §3.7 step 4).
				// Catches uninstall / partial-cleanup mid-tick before we burn
				// the next network call. preTickChecks ran at start of Tick;
				// this is the inner-loop equivalent.
				if midErr := l.preChunkChecks(); midErr != nil {
					l.log.Printf("[fatal] %v", midErr)
					return midErr
				}
				if sendErr := l.sink.SendChunk(ctx, c); sendErr != nil {
					l.log.Printf("[error] sink: %v", sendErr)
					totalErrors++
					if errors.Is(sendErr, api.ErrKeyRevoked) || errors.Is(sendErr, api.ErrInvalidToken) {
						return sendErr // fatal — propagate to Loop.Run, then runRun
					}
					break
				}
				totalChunks++
				l.state.Files[c.File] = config.FileWatermark{Offset: c.ToOffset, LastSync: l.now()}
				if fatal := l.saveStateOrFatal("post-send"); fatal != nil {
					return fatal
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

// preTickChecks runs the read-only sentinel + config + lockfile stats at the
// start of every Tick. Spec §3.7 step 4 / R10-F1. Order matches the runRun
// pre-flight: sentinel (fail-closed) → paused → config.toml → lockfile.
//
// Returns:
//   - config.ErrUninstallInProgress: .uninstalling present (or stat failed)
//   - ErrPausedSkip: paused sentinel present (Run loop treats as skip, not fatal)
//   - config.ErrConfigRemoved: config.toml gone
//   - nil: safe to proceed
//
// Lockfile-missing is intentionally NOT returned — uninstall removes the
// lockfile last (ordered_delete (g)), and by that point the sentinel will
// already be present and caught above. A standalone "lock missing" check
// would only mis-fire when an operator manually deleted .lock, which we
// don't need to special-case.
func (l *Loop) preTickChecks() error {
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return config.ErrUninstallInProgress
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w (sentinel stat: %v; fail-closed)", config.ErrUninstallInProgress, err)
	}
	if _, err := os.Stat(config.PausedPath()); err == nil {
		l.log.Printf("[paused] skipping tick")
		return ErrPausedSkip
	}
	if _, err := os.Stat(config.ConfigPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return config.ErrConfigRemoved
		}
		// transient stat error — retry-friendly, don't kill the daemon.
	}
	return nil
}

// preChunkChecks is the per-SendChunk re-check inside the chunk loop. It
// runs the same sentinel + config stats as preTickChecks but skips the
// paused branch — once we've started processing a tick we want to finish
// or abort cleanly, not transition mid-stream to a paused state.
func (l *Loop) preChunkChecks() error {
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return config.ErrUninstallInProgress
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w (sentinel stat: %v; fail-closed)", config.ErrUninstallInProgress, err)
	}
	if _, err := os.Stat(config.ConfigPath()); errors.Is(err, fs.ErrNotExist) {
		return config.ErrConfigRemoved
	}
	return nil
}

// saveStateOrFatal wraps config.SaveState with typed dispatch (spec §3.7 /
// R14-F1 / R15-F3). The three config sentinels mean the daemon should exit
// cleanly because uninstall is in progress / done — return them so Tick
// propagates up to runRun, which maps them to ExitError{Code:0}. Any other
// error (disk full, EIO, EROFS) is a transient IO failure — log at [error]
// and continue, preserving PR2 behaviour.
func (l *Loop) saveStateOrFatal(label string) error {
	saveErr := config.SaveState(l.state)
	if saveErr == nil {
		return nil
	}
	switch {
	case errors.Is(saveErr, config.ErrUninstallInProgress),
		errors.Is(saveErr, config.ErrConfigRemoved),
		errors.Is(saveErr, config.ErrRootRemoved):
		l.log.Printf("[fatal] save state (%s): %v; daemon exiting", label, saveErr)
		return saveErr
	default:
		l.log.Printf("[error] save state (%s): %v", label, saveErr)
		return nil
	}
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

// Compile-time interface assertions.
var (
	_ ResolverIface = (*CWDResolver)(nil)
	_ Logger        = (*config.RFCLogger)(nil)
)

// allowed reports whether cwd is within any of the include paths. cwd is
// resolved via filepath.EvalSymlinks first so attacker-supplied symlinks
// cannot trick the prefix match (spec §6.1). On EvalSymlinks failure the
// raw cwd is used as a best-effort fallback — the caller path elsewhere
// already rejects symlinks at file-listing time, and we prefer not to
// silently drop traffic just because a directory was just renamed.
// IncludePaths are expected to be pre-canonicalised at enrol/add-path
// write-time (spec §4.2).
func allowed(cwd string, includes []string) bool {
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		resolved = cwd
	}
	for _, inc := range includes {
		if resolved == inc || strings.HasPrefix(resolved, inc+"/") {
			return true
		}
	}
	return false
}
