# caliber-agent Phase 2 PR2 — Watcher + stub-sink + run command

**Date:** 2026-05-21
**Author:** brainstorming session (h4 + Claude)
**Status:** Approved design, pending implementation
**Parent specs:**
- `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` (Phase 2 — Daemon MVP)
- `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md` (Phase 2 PR1)
**Depends on:** PR #160 (`feat(agent): Phase 2 PR1 — scaffold + enroll end-to-end`) must merge first
**Tracking PR:** to be created

---

## 1. Goal

Make the caliber-agent daemon actually *do something*. PR2 introduces `caliber-agent run`, a foreground daemon loop that every 60 seconds walks `~/.claude/projects/` and `~/.codex/sessions/`, filters by the `include_paths` allow-list set during PR1's `enroll`, tails new bytes from each transcript, splits them into chunks, and delivers each chunk to a `Sink` interface. PR2 ships a **stub `LogSink`** that writes metadata-only lines to `~/.caliber-agent/agent.log` and ACKs immediately so the daemon's watermark advances. PR3 replaces the stub with a real HTTP ingest client.

The success criterion for PR2: after PR1's enroll has been completed and at least one path is in the allow-list, running `caliber-agent run --once` against a real `~/.claude/projects` produces:
1. A `[chunk]` line per processed transcript in `agent.log` carrying metadata only (no event content).
2. A `state.json` whose `files` map has an advanced `Offset` for each processed transcript.
3. Exit code 0.

---

## 2. Non-Goals (explicit)

The following are intentionally out of scope and have their own future PRs:

- `POST /v1/ingest` HTTP client (PR3)
- gzip chunk encoding (PR3)
- Retry / exponential backoff for HTTP failures (PR3)
- Redaction layer with `metadata-only` / `redacted-body` / `full-body` modes (PR3)
- Per-org redaction set fetch on enrollment + every 24h (PR3)
- launchd plist and `caliber-agent install-launchd` (PR4)
- Real implementations of `status` / `pause` / `resume` / `set-mode` / `add-path` / `remove-path` / `uninstall` (PR4+)
- Homebrew tap push automation (PR4)
- Linux build target (Phase 5+)
- `agent.log` rotation (Phase 3 — daemon ships an unbounded append-only log in PR2)

---

## 3. Repo Layout

PR2 adds two new packages (`watcher`, `sink`), one helper file in an existing package (`config/log.go`), and replaces one stub (`cli/run.go`).

```
ai-dev-eval/agent/
  cmd/caliber-agent/main.go                    (unchanged from PR1)
  internal/
    cli/
      run.go                                   REPLACES PR1 stub (was ExitNotImplemented)
      run_test.go                              new
    watcher/                                   new package
      sources.go                               Source interface + FileRef type
      claude.go                                ClaudeSource (walks projects + subagents)
      claude_test.go
      codex.go                                 CodexSource (walks sessions/YYYY/MM/DD)
      codex_test.go
      tail.go                                  Tailer: single-file from-offset reader
      tail_test.go
      chunker.go                               Chunker.Split (PR2: 1 chunk per file)
      chunker_test.go
      loop.go                                  Loop.Run + Loop.Tick orchestrator
      loop_test.go
      resolve.go                               ResolveCWD helper (extracted from wizard)
      resolve_test.go
    sink/                                      new package
      chunk.go                                 Chunk type — frozen contract for PR3
      sink.go                                  Sink interface
      log.go                                   LogSink: stub implementation
      log_test.go
    config/
      log.go                                   new — OpenAgentLog
      log_test.go
  scripts/
    smoke-run.sh                               new — manual `run --once` smoke
```

### Module boundaries (frozen at PR2)

| Package | Owns | Does NOT do |
|---|---|---|
| `watcher/sources` | enumerating which files exist under each source root | reading file content; redaction; HTTP |
| `watcher/tail` | reading new bytes from a single file given an offset; splitting on `\n`; reporting truncation/missing | parsing JSON; chunking; talking to sink |
| `watcher/chunker` | grouping a `TailResult` into one or more `Chunk` values | gzipping; transport |
| `watcher/loop` | orchestrating sources × tail × chunker × sink per 60-second tick | knowing source internals; deciding sink type |
| `watcher/resolve` | resolving a Claude project dir to an absolute `cwd` (JSONL primary + dirname fallback, `io.LimitReader`-bounded) | filesystem walking; HTTP |
| `sink` | the `Sink` interface + the `LogSink` stub implementation | filesystem walking; tailing; chunking |
| `cli/run` | wiring the loop, signal handling, exit codes | any of the above |
| `config/log` | opening `agent.log` with the right path / perm / append mode | logging format; rotation |

---

## 4. Components

### 4.1 `sink/chunk.go` — the Chunk type (frozen contract)

```go
package sink

// Chunk is the unit of work passed from the watcher's loop to a Sink.
// Frozen at PR2: PR3 evolves Events from []string to []Event (redacted),
// but the rest of the fields stay stable so the watcher loop doesn't change.
type Chunk struct {
    File            string   // absolute path of the source transcript
    Source          string   // "claude" | "claude-subagent" | "codex"
    SessionID       string
    ParentSessionID string   // claude-subagent only; "" otherwise
    CWD             string   // resolved cwd at scan time (must be in cfg.IncludePaths)
    Events          []string // raw JSONL lines in file order, '\n' stripped
    FromOffset      int64    // byte offset BEFORE the first event in this chunk
    ToOffset        int64    // byte offset AFTER the last event; loop advances watermark to this
}
```

PR3 will most likely:
- replace `Events []string` with `Events []Event` (redacted, typed) — `Event` defined in the redaction package
- keep all other fields identical

### 4.2 `sink/sink.go` + `sink/log.go`

```go
// sink.go
type Sink interface {
    // SendChunk delivers c. On nil return the watcher loop advances
    // state.Files[c.File].Offset to c.ToOffset and persists state.
    // On non-nil error the watermark stays put; the loop retries next tick.
    SendChunk(ctx context.Context, c Chunk) error
}

// log.go
type LogSink struct {
    Writer io.Writer
    Now    func() time.Time // injectable for tests
}

func NewLogSink(w io.Writer) *LogSink

func (s *LogSink) SendChunk(ctx context.Context, c Chunk) error {
    // ONLY metadata to disk — never raw content (privacy contract).
    if _, err := fmt.Fprintf(s.Writer,
        "%s [chunk] source=%s file=%s session=%s parent=%s cwd=%s events=%d bytes=%d-%d\n",
        s.Now().UTC().Format(time.RFC3339),
        c.Source, c.File, c.SessionID, c.ParentSessionID, c.CWD,
        len(c.Events), c.FromOffset, c.ToOffset,
    ); err != nil {
        // Disk-full, broken pipe, closed file. Returning non-nil keeps the
        // watermark put so the next tick reprocesses the same byte range
        // (at-least-once). Swallowing this would silently lose PR2 output
        // while still advancing state.
        return fmt.Errorf("logsink: write: %w", err)
    }
    return nil
}
```

`LogSink` never inspects `c.Events`. The test suite has an explicit regression guard verifying that no event content reaches the log, plus a guard that a failing writer surfaces the error to the loop.

### 4.3 `watcher/sources.go`

```go
package watcher

type FileRef struct {
    Path            string // absolute
    Source          string // "claude" | "claude-subagent" | "codex"
    SessionID       string
    ParentSessionID string // empty unless Source == "claude-subagent"
    CWD             string // populated by sources that can determine cwd
                           // cheaply from their own layout (codex via session_meta).
                           // Claude refs leave this "" — the loop calls CWDResolver
                           // because Claude needs a per-DIR algorithm that wins from
                           // being shared across all sessions under the same dir.
}

type Source interface {
    Name() string                              // for logs
    List(ctx context.Context) ([]FileRef, error)
}
```

**Why two ways of getting cwd, not one:** Claude's first JSONL line is heterogeneous (often a `queue-operation` event with no `cwd`); the cwd has to be found via a bounded scan of multiple lines or a dirname-decode fallback. That work is per-DIR (every session in `<encoded-cwd>/` shares the same cwd) and is wasteful per-FILE. Codex's first JSONL line is *guaranteed* to be a `session_meta` with `payload.cwd`, so each Codex `FileRef` can carry its own cwd cheaply. The split puts the cheap work in the source and the expensive work behind a shared, cached resolver.

### 4.4 `watcher/claude.go`

```go
type ClaudeSource struct {
    Root string // ~/.claude/projects
}

func NewClaudeSource(root string) *ClaudeSource

// List walks Root and returns:
//   1. Every <Root>/<encoded-cwd>/*.jsonl — Source="claude", SessionID=<filename-uuid>,
//      ParentSessionID=""
//   2. Every <Root>/<encoded-cwd>/<sessionID>/subagents/agent-*.jsonl —
//      Source="claude-subagent",
//      SessionID = strings.TrimPrefix(strings.TrimSuffix(filename, ".jsonl"), "agent-"),
//      ParentSessionID = <sessionID> from the parent dir name
//
// Skips:
//   - non-directories at Root level
//   - dirs not beginning with "-" (Claude's encoded-cwd convention)
//   - non-*.jsonl files
//   - missing `subagents/` subdir (most sessions don't have one)
//
// Canonical-id contract for Claude:
//   Claude's storage layout encodes the canonical session/agent ids in
//   the filename and parent dirname. Empirically (verified 2026-05-21
//   against ~/.claude/projects/), for every subagent file:
//     filename "agent-<id>.jsonl"  →  JSONL's per-event `agentId` == <id>
//     parent dir name              →  JSONL's per-event `sessionId` == that dir name
//   So PR2's filename-derived IDs are the canonical IDs by construction.
//   PR2 does NOT open these files to verify (would explode List I/O —
//   subagents are rare but main-session files would too if we generalised).
//   PR3's redaction step has every event in hand and SHOULD assert that
//   the filename-derived (Source, SessionID, ParentSessionID) matches
//   the first observed event's (sessionId, agentId) — divergence is a
//   Claude-internal bug worth surfacing as a [warn] but not blocking.
```

### 4.5 `watcher/codex.go`

```go
type CodexSource struct {
    Root string // ~/.codex/sessions
}

// List walks Root/YYYY/MM/DD/rollout-*.jsonl. The three nested dir layers
// are matched as `[0-9]{4}/[0-9]{2}/[0-9]{2}` to skip stray non-date dirs.
//
// SessionID extraction: the filename pattern is rollout-YYYY-MM-DDTHH-MM-SS-<UUID>.jsonl.
// SessionID = the UUID segment.
//
// CWD extraction: for each matched file, read the first line via the
// injectable opener (default os.Open), io.LimitReader-bounded to 64 KiB so
// even a malformed file can't OOM us. Parse as JSON, look for
// payload.cwd (string). If parse fails or field absent, leave CWD="" and
// the loop will skip the ref (Codex without session_meta is malformed and
// cannot be allow-list-filtered safely).
//
// Source="codex", ParentSessionID="" always.
```

### 4.6 `watcher/tail.go`

```go
type Tailer struct {
    // Open returns a handle that supports Read + Seek + Close. The Seek
    // requirement is intentional — the tail algorithm seeks to the
    // watermark offset before reading. `os.Open` satisfies this contract
    // because `*os.File` implements all three interfaces. Tests inject
    // wrappers that also count bytes read.
    Open func(path string) (io.ReadSeekCloser, error) // injectable; default os.Open
    Stat func(path string) (int64, error)             // injectable; default os.Stat-based size
}

type TailResult struct {
    Events     []string // raw JSONL lines, '\n' stripped, in file order
    FromOffset int64
    ToOffset   int64
    Skipped    int      // empty lines / whitespace-only lines, not error
}

var (
    ErrFileGone    = errors.New("tail: file gone")
    ErrFileShrank  = errors.New("tail: file shrank") // sentinel; loop catches and resets
)

func (t *Tailer) Read(path string, fromOffset int64) (TailResult, error)
```

Behaviour:
1. `Stat(path)` to get size. If `os.IsNotExist`: return `ErrFileGone`.
2. If `size < fromOffset`: return `ErrFileShrank` (loop handles reset).
3. If `size == fromOffset`: return `TailResult{FromOffset: fromOffset, ToOffset: fromOffset, Events: nil}` (no work).
4. Otherwise: open + `Seek(fromOffset, io.SeekStart)` + `bufio.NewReaderSize(64 KiB)` + read loop with bounded line+tick allocations (see below).

**Bounded reads — memory safety contract:**

Two explicit caps (both in `tail.go` as `const`):

```go
const (
    maxLineBytes = 4  * 1024 * 1024  // 4 MiB; per-line cap
    maxTickBytes = 16 * 1024 * 1024  // 16 MiB; per-file per-tick cap on Events total
)
```

The read loop uses `bufio.Reader.ReadSlice('\n')` (which respects the bufio buffer size and returns `ErrBufferFull` rather than allocating unbounded). For each `ReadSlice` call:

```
slice, err = reader.ReadSlice('\n')
    if err == io.EOF and len(slice) > 0: last line is INCOMPLETE — DROP, do NOT advance ToOffset over it
    if err == io.EOF and len(slice) == 0: clean end
    if err == bufio.ErrBufferFull: keep calling ReadSlice and APPENDING to an accumulating buffer until '\n' or len > maxLineBytes
        if accumulated > maxLineBytes BEFORE finding '\n':
            DROP the line content (do not add to Events), but CONTINUE consuming via ReadSlice until '\n' is found (so byte accounting reaches the next line boundary)
            advance ToOffset over all bytes consumed for this oversize line
            increment OversizeDropped counter
        if accumulated > maxLineBytes after we already found '\n': same — drop content, advance ToOffset, OversizeDropped++
    if err == nil: full line, len(slice) ≤ buffer; trim '\n'; classify (whitespace / event)

After each completed line:
    cumulativeEventBytes += len(line)
    if cumulativeEventBytes >= maxTickBytes:
        BREAK the loop (stop reading this file this tick; remainder gets next tick)
        ToOffset already reflects everything we read
```

Each completed line classifies as:
- **Empty or whitespace-only** → increment `Skipped`, do NOT include in `Events`, **DO advance `ToOffset` over the line's bytes**.
- **Oversize (> maxLineBytes)** → increment `OversizeDropped`, do NOT include in `Events`, **DO advance `ToOffset`** (we consumed those bytes; next tick must not re-read them).
- **Last line without trailing `\n`** (file is being appended): DROP entirely. `ToOffset` ends at the position right after the last completed `\n`. The incomplete bytes are NOT counted; next tick re-reads from there once the writer flushes the `\n`.
- **Otherwise**: append the line (without `\n`) to `Events`, advance `ToOffset` over the line's bytes.

`TailResult` gains a counter:

```go
type TailResult struct {
    Events           []string
    FromOffset       int64
    ToOffset         int64
    Skipped          int
    OversizeDropped  int  // new: lines that exceeded maxLineBytes
    TickBudgetHit    bool // new: true if cumulativeEventBytes >= maxTickBytes caused early stop
}
```

The loop logs `[warn] oversize line dropped` per `OversizeDropped > 0` ref and `[warn] per-tick byte budget hit, resuming next tick` when `TickBudgetHit` is true.

**Invariant**: `ToOffset >= FromOffset` always; total bytes held in `Events` is bounded by `maxTickBytes` (not file size, not line count).

**Memory bound:** `bufio.NewReaderSize(64 KiB)` plus the cumulative `Events` slice. Worst case: one transcript file produces a `TailResult` with all of its post-offset bytes in memory. The 60-second poll cadence means this is bounded by the rate of writes to one file in one minute — single-digit MB realistically. Chunker may split if/when the spec needs (PR3, gzip-sized chunks).

### 4.7 `watcher/chunker.go`

```go
type Chunker struct{}

func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk
// PR2: returns exactly one Chunk (or zero if tr.Events is empty).
// PR3: will split by gzipped size (~1 MB target per chunk), maintaining
// line-boundary FromOffset/ToOffset alignment.
```

### 4.8 `watcher/resolve.go`

```go
// Extracted from wizard.ScanClaudeProjects so the watcher can resolve cwd
// per ref without pulling the wizard's whole candidate-listing logic.
//
// Same JSONL-primary + dirname-fallback algorithm as the wizard.
// Same io.LimitReader 256 KiB per-dir cap.
// Same greedy stat-guided dirname decode.

type CWDResolver struct {
    Open func(path string) (io.ReadCloser, error) // reuse PR1 injection point
}

// NewCWDResolver constructs a resolver. If open is nil, defaults to
// wrapping os.Open — production callers may safely pass nil; tests pass a
// counting wrapper to assert the io.LimitReader bound.
func NewCWDResolver(open func(path string) (io.ReadCloser, error)) *CWDResolver

// Claude case: claudeProjDir is <Root>/<encoded-cwd>; pass the dir, not a session file.
// Codex case: not applicable — CodexSource embeds cwd extraction from session_meta event.
//   The watcher reads cwd from the FIRST line of a Codex transcript on first observation;
//   subsequent tail reads don't need to re-resolve.
//
// This split (Claude needs a resolver, Codex doesn't) reflects the different file
// layouts and is the simplest correct boundary.
//
// Return contract:
//   (cwd, nil)  — successfully resolved; cwd is an absolute, stat-verified directory
//   ("",  nil)  — no I/O error but the dirname did not decode to any existing path
//                  AND no JSONL line in the budget provided a usable cwd; caller skips
//   ("",  err)  — I/O error (e.g. open failure on a known file); caller logs as [error]
func (r *CWDResolver) ResolveClaude(claudeProjDir string) (string, error)
```

Wizard refactor: pull `ScanClaudeProjects`'s inner cwd-resolution into this `CWDResolver`, then have wizard call it. PR2 commit titled `refactor(agent): extract CWDResolver from wizard for watcher reuse`. No behaviour change in wizard; tests stay green.

### 4.9 `watcher/loop.go`

```go
type Loop struct {
    Sources    []Source
    Tailer     *Tailer
    Chunker    *Chunker
    Sink       sink.Sink
    Config     *config.Config
    State      *config.State            // mutated in-place, persisted after each successful SendChunk
    Resolver   *CWDResolver
    Log        Logger                   // interface; production uses config.RFCLogger (UTC-RFC3339 lines), tests use a fake
    Now        func() time.Time         // injectable; default time.Now
    Interval   time.Duration            // default 60s; overridable via --interval flag for tests

    cwdCache   map[string]string        // unexported; key = ref.Path (codex) or claudeProjDir (claude)
                                        // populated on first SUCCESSFUL resolve; survives across ticks
                                        // never invalidated within PR2's daemon lifetime
                                        //   (resolved cwds are immutable for the file's lifetime)
                                        // empty-string cwd ("unresolved") and I/O errors are NOT cached —
                                        // each tick retries those refs from scratch
}

// NewLoop constructs a Loop with all unexported fields (notably cwdCache)
// initialised. Callers in package `cli` use this constructor; direct
// struct-literal construction in tests is also fine if the test also
// initialises cwdCache via lazy init (see resolveCWDForRef).
func NewLoop(...) *Loop

// resolveCWDForRef implements the unified resolution contract:
//   1. Lazy init: if l.cwdCache == nil { l.cwdCache = make(map[string]string) }
//      Defensive against struct-literal construction in tests.
//   2. If ref.CWD != "" (Codex populates this in Source.List): cache by ref.Path + return (cwd, nil)
//   3. Else (Claude):
//      a. claudeProjDir = parent of ref.Path; for subagents, walk up two parents to reach the encoded-cwd dir
//      b. If l.cwdCache[claudeProjDir] != "" (i.e. previously resolved successfully): return cached value
//      c. Else: call Resolver.ResolveClaude(claudeProjDir)
//         - on (cwd, nil) with cwd != "": cache and return
//         - on ("", nil) [unresolved]: return unchanged, do NOT cache (next tick retries)
//         - on ("", err): return unchanged, do NOT cache (next tick retries)
//
// Three-state contract — same as CWDResolver.ResolveClaude:
//   (cwd, nil)  resolved
//   ("",  nil)  no I/O error, but no usable cwd; caller skips
//   ("",  err)  I/O failure; caller logs
func (l *Loop) resolveCWDForRef(ref FileRef) (string, error)

type Logger interface {
    Printf(format string, args ...any)
}

// Run blocks until ctx.Done(). Returns ctx.Err() on cancellation, or
// the first non-recoverable error (currently: none — see error handling §6).
func (l *Loop) Run(ctx context.Context) error

// Tick performs a single iteration: list all sources, filter by allow-list,
// tail new bytes, chunk, send, advance state. Recoverable per-ref errors
// are logged and skipped; Tick itself only returns ctx.Err() if cancelled.
func (l *Loop) Tick(ctx context.Context) error
```

Tick algorithm:

```
sourceList: for each Source:
  refs, err = src.List(ctx)
  if err: Log "[warn] source %s unavailable: %v"; continue sourceList
  ALLOW: for ref in refs:
    if ctx.Err(): break SOURCELOOP
    cwd, err := resolveCWDForRef(ref)   // see contract below
    if err != nil: Log "[error] resolve cwd %s: %v"; continue ALLOW
    if cwd == "":  Log "[debug] cwd unresolved: %s"; continue ALLOW
    if !allowed(cwd, cfg.IncludePaths): continue ALLOW
    wm := State.Files[ref.Path]  // {Offset:0} if absent
    tr, terr := Tailer.Read(ref.Path, wm.Offset)
    if errors.Is(terr, ErrFileGone):
      Log "[warn] file gone: %s"; continue ALLOW
    if errors.Is(terr, ErrFileShrank):
      // MUST persist the reset offset immediately, BEFORE re-tailing.
      // Otherwise a shrink-to-empty (or shrink-to-incomplete-line) leaves
      // the old too-large offset in state.json; next tick stat-compares
      // and re-triggers ErrFileShrank forever.
      Log "[warn] file shrank from %d, resetting offset to 0: %s", wm.Offset, ref.Path
      wm.Offset = 0
      State.Files[ref.Path] = {Offset: 0, LastSync: Now()}  // shrink reset IS a watermark advance per LastSync redefinition (§5)
      if err := config.SaveState(State); err != nil:
        Log "[error] save state (shrink reset): %v"
        // Even if SaveState failed, continue with the re-tail — at-least-once
        // contract tolerates this; worst case we re-shrink-reset next tick.
      tr, terr = Tailer.Read(ref.Path, 0)
      if terr != nil: Log "[error] tail after reset: %v"; continue ALLOW
    if terr != nil: Log "[error] tail: %v"; continue ALLOW
    if tr.ToOffset == wm.Offset: continue ALLOW  // no completed lines at all
    chunks := Chunker.Split(ref, tr, cwd)
    if len(chunks) == 0 && tr.ToOffset > wm.Offset:
      // Whitespace-only segment: we read past blank lines but produced
      // no events. Advance watermark anyway — otherwise the next tick
      // would re-read the same blanks forever. No sink call needed
      // because there's nothing to deliver.
      State.Files[ref.Path] = {Offset: tr.ToOffset, LastSync: Now()}
      if err := config.SaveState(State); err != nil:
        Log "[error] save state (whitespace-only): %v"
      continue ALLOW
    for c in chunks:
      if ctx.Err(): break SOURCELOOP
      if err := Sink.SendChunk(ctx, c); err != nil:
        Log "[error] sink: %v"; break  // skip remaining chunks for THIS ref this tick
      State.Files[c.File] = {Offset: c.ToOffset, LastSync: Now()}
      if err := config.SaveState(State); err != nil:
        Log "[error] save state: %v"  // keep going; in-memory update preserved
Log "[tick-end] sources=%d refs=%d chunks=%d errors=%d duration=%s"
```

### 4.10 `config/log.go`

This file ships two tightly-paired pieces: the file opener for `agent.log`, and a minimal formatted writer that emits the UTC-RFC3339 line format the spec §5 freezes.

```go
func OpenAgentLog() (*os.File, error) {
    path := LogPath() // PR1 already exposes this
    f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
    if err != nil { return nil, err }
    return f, nil
}

// RFCLogger formats lines as: "<UTC-RFC3339> <printf-rendered>\n".
// stdlib `log.New(...)` with `log.LstdFlags|log.LUTC` emits Go's
// "YYYY/MM/DD HH:MM:SS" format — that violates the §5 external contract
// which freezes UTC-RFC3339. RFCLogger is what the watcher loop and any
// future component should use.
//
// The Printf signature matches watcher.Logger so RFCLogger satisfies
// that interface directly. The format string must NOT include a
// trailing newline; Printf appends one.
type RFCLogger struct {
    Target io.Writer
    Now    func() time.Time // injectable; default time.Now
}

func NewRFCLogger(target io.Writer) *RFCLogger {
    return &RFCLogger{Target: target, Now: time.Now}
}

func (l *RFCLogger) Printf(format string, args ...any) {
    line := fmt.Sprintf(format, args...)
    fmt.Fprintf(l.Target, "%s %s\n", l.Now().UTC().Format(time.RFC3339), line)
}
```

### 4.11 `cli/run.go`

```go
func newRunCmd() *cobra.Command {
    var once bool
    var interval time.Duration
    cmd := &cobra.Command{
        Use:   "run",
        Short: "Run the daemon main loop (foreground; launchd-managed in production)",
        RunE: func(cmd *cobra.Command, _ []string) error {
            return runRun(cmd, once, interval)
        },
    }
    cmd.Flags().BoolVar(&once, "once", false, "run a single tick then exit (smoke-test affordance)")
    cmd.Flags().DurationVar(&interval, "interval", 60*time.Second, "polling interval between ticks")
    return cmd
}

func runRun(cmd *cobra.Command, once bool, interval time.Duration) error {
    cfg, err := config.Load()
    if err != nil {
        return &ExitError{Code: 1, Err: fmt.Errorf("device not enrolled; run `caliber-agent enroll` first: %w", err)}
    }
    if _, err := keychain.Get(cfg.DeviceID); err != nil {
        return &ExitError{Code: 1, Err: fmt.Errorf("device key missing from keychain; re-run `caliber-agent enroll`: %w", err)}
    }
    state, err := config.LoadState()
    if err != nil {
        return &ExitError{Code: 1, Err: fmt.Errorf("load state: %w", err)}
    }
    logFile, err := config.OpenAgentLog()
    if err != nil {
        return &ExitError{Code: 1, Err: fmt.Errorf("open agent.log: %w", err)}
    }
    defer logFile.Close()
    // Mirror agent.log lines to stderr for foreground inspection.
    logger := config.NewRFCLogger(io.MultiWriter(logFile, cmd.ErrOrStderr()))

    loop := watcher.NewLoop(watcher.LoopOpts{
        Sources: []watcher.Source{
            watcher.NewClaudeSource(claudeProjectsRoot()),
            watcher.NewCodexSource(codexSessionsRoot(), nil), // opener nil → default os.Open
        },
        Tailer:   &watcher.Tailer{},
        Chunker:  &watcher.Chunker{},
        Sink:     sink.NewLogSink(logFile),
        Config:   cfg,
        State:    state,
        Resolver: watcher.NewCWDResolver(nil),
        Log:      logger,
        Now:      time.Now,
        Interval: interval,
    })
    // NewLoop initialises the cwdCache; lazy init in resolveCWDForRef
    // remains as a defensive fallback for struct-literal use in tests.

    if once {
        return loop.Tick(cmd.Context())
    }
    return loop.Run(cmd.Context())
}
```

`claudeProjectsRoot()` already exists in `enroll.go` from PR1. `codexSessionsRoot()` is a sibling helper added by this PR, identical shape but defaulting to `~/.codex/sessions` and reading `CALIBER_CODEX_SESSIONS` for the test override.

---

## 5. Data Flow

### Happy path (one Tick)

```
run --once          Loop                  Sources                Tailer       Chunker       LogSink         State          agent.log
   │                  │                      │                     │             │              │              │                │
   │  Tick(ctx)       │                      │                     │             │              │              │                │
   ├─────────────────►│                      │                     │             │              │              │                │
   │                  ├─►Claude.List         │                     │             │              │              │                │
   │                  │◄─[refs...]           │                     │             │              │              │                │
   │                  ├─►Codex.List          │                     │             │              │              │                │
   │                  │◄─[refs...]           │                     │             │              │              │                │
   │                  │                      │                     │             │              │              │                │
   │                  │ for each ref:        │                     │             │              │              │                │
   │                  │   cwd = resolve(ref) (cached per tick)     │             │              │              │                │
   │                  │   if !allowed: skip                        │             │              │              │                │
   │                  ├──────────────────────────────────────────►│                                                              │
   │                  │                      │                     │  Stat → size                                                │
   │                  │                      │                     │  if size < wm.Offset: ErrFileShrank                         │
   │                  │                      │                     │  open + seek + ReadString('\n') until EOF                   │
   │                  │                      │                     │  drop trailing incomplete line                              │
   │                  │◄──────────────────────────────────────────┤  TailResult                                                  │
   │                  │   if tr.ToOffset == wm.Offset: skip       │             │              │              │                │
   │                  ├─────────────────────────────────────────────────────────►│                                              │
   │                  │◄────────────────────────────────────────────────────────┤ []Chunk                                       │
   │                  │   for chunk:                              │             │              │              │                │
   │                  ├──────────────────────────────────────────────────────────────────────►│ SendChunk     │                │
   │                  │                                                                       ├─[chunk] line  ────────────────►│
   │                  │◄─────────────────────────────────────────────────────────────────────┤ nil                              │
   │                  │   State.Files[path] = {ToOffset, Now()}                              │              │                │
   │                  ├────────────────────────────────────────────────────────────────────────────────────►│ SaveState (atomic)│
   │                  │ Log [tick-end] sources=N refs=R chunks=C errors=0                                                      │
   │  exit 0          │ return nil                                                                                              │
   │◄─────────────────┤                                                                                                          │
```

### Failure shapes (also see §6)

| ID | Trigger | Behaviour | Exit / next-tick effect |
|---|---|---|---|
| A | File gone between `List` and `Tail` | Log `[warn] file gone`; State entry preserved; continue | Tick OK; next tick may find the file again |
| B | File shrank (`size < wm.Offset`) | Log `[warn] resetting`; tail from 0; deliver chunk; advance | Tick OK; duplicate delivery to PR3 ingest server (server dedupes by event UUID) |
| C | `Sink.SendChunk` returns error | Log `[error] sink`; do NOT advance; break remaining chunks for this ref | Tick OK; next tick retries the same byte range |
| D | `ResolveCWD` returns `("", nil)` | Log `[debug] cwd unresolved` (only at -v); skip; State unchanged | Tick OK; next tick retries |
| D' | `ResolveCWD` returns `("", err)` (I/O failure) | Log `[error] resolve cwd: %v`; skip; State unchanged | Tick OK; next tick retries |
| E | `SaveState` fails after sink ack | Log `[error] save state`; keep in-memory update | Tick OK; next ack will retry SaveState |
| F | SIGTERM mid-tick | Let in-flight `SendChunk` complete; break ref loop; SaveState; return ctx.Err() | exit 130 |
| G | `keychain.Get` fails at startup | `*ExitError{Code:1, "device key missing..."}` | exit 1, loop never starts |
| H | `agent.log` cannot be opened | `*ExitError{Code:1, "open agent.log..."}` | exit 1 |
| I | `config.LoadState` corrupted JSON | `*ExitError{Code:1, "load state..."}` | exit 1 (Phase 3 will add a `--repair-state` affordance) |

### Idempotency boundary

All events delivered at-least-once. Duplicate delivery sources:
- Failure B (file shrank → re-read from 0)
- Failure E (crash between sink ack and successful SaveState)
- Failure C followed by tick-loop re-tail of the same range

The PR3 server uses `(session_id, event_uuid)` dedup. PR2 does NOT attempt at-most-once.

### External contract (frozen at PR2)

- `caliber-agent run [--once] [--interval D]`
- Exit codes: 0 / 1 / 70 / 130 (unchanged from PR1 §8 contract)
- `~/.caliber-agent/agent.log` append-only, 0600, UTC-RFC3339 timestamps, line-oriented
- `~/.caliber-agent/state.json`:
  - `Files[path].Offset` = next byte to read
  - `Files[path].LastSync` = UTC timestamp of the most recent successful **watermark advance** for that file (covers all three cases: sink ACK with chunk delivery, whitespace-only segment advance, and shrink reset to 0). Was previously specified as "sink ACK only" — redefined here because the watermark can legitimately advance without a sink call.
- `Sink` interface + `Chunk` type are the seam for PR3
- Environment overrides (test-only):
  - `CALIBER_CLAUDE_PROJECTS` — inherited from PR1 (already documented in PR1 §8)
  - `CALIBER_CODEX_SESSIONS` — new in PR2 (see §8)

---

## 6. Error Handling Principles

1. **Tick never fails fast.** All per-ref / per-chunk errors are caught + logged + skipped. The only thing that aborts a Tick early is `ctx.Done()`. The daemon prefers degraded operation to crash-restart cycles.
2. **Sink failure halts the current ref's remaining chunks but not the tick.** This avoids out-of-order delivery (chunk N+1 cannot be sent before chunk N is ACKed).
3. **Watermark advances ONLY on successful sink ACK + immediately afterwards.** SaveState failure does NOT roll back the in-memory advance; it just logs and lets the next ACK retry the write. Crash-loss between ACK and SaveState produces at-least-once duplication, which the server dedupes.
4. **State entries are never deleted by the watcher.** Transient missing files (Dropbox sync, worktree moves, etc.) keep their watermark so reappearance doesn't re-deliver. A future `vacuum` or `uninstall` command (Phase 3+) handles cleanup.
5. **agent.log is the canonical observability surface.** All warns/errors go to agent.log. In foreground mode (`--once` or interactive `run`), stderr mirrors it so the operator can see live output. No info-level events go to stdout — daemon stdout stays empty for clean launchd handling.
6. **No silent error swallowing.** Every caught-and-continued error is logged with severity prefix. The `_ = err` pattern only appears in `defer file.Close()` and similar idempotent teardown.
7. **No retries within a tick.** Sink failures are retried by "next tick processes the same byte range" rather than in-tick exponential backoff. PR3 HTTP backoff lives inside the HTTP-sink's `SendChunk` and is transparent to the loop.
8. **Exit codes stable at PR1's contract.** PR2 introduces NO new exit codes.

### Log format

```
2026-05-21T11:14:02Z [chunk] source=claude file=/Users/h/.claude/projects/-Users-h-ai-dev-eval/<uuid>.jsonl session=<uuid> parent= cwd=/Users/h/ai-dev-eval events=23 bytes=8192-12480
2026-05-21T11:14:02Z [warn] file shrank from 8192 to 0, resetting watermark: /Users/.../sess.jsonl
2026-05-21T11:14:02Z [error] sink: <err>
2026-05-21T11:14:02Z [tick-end] sources=2 refs=5 chunks=3 errors=0 duration=240ms
```

Prefixes: `[chunk]`, `[warn]`, `[error]`, `[debug]`, `[tick-end]`. Future PRs may add `[ingest]`, `[redact]`.

---

## 7. Testing

Target: maintain the 80% gate from PR1. `watcher/*` and `sink/*` are fully testable (no TTY, no external binary). Expected per-package coverage: `sink` ≥ 95%, `watcher/sources` ≥ 85%, `watcher/tail` ≥ 90%, `watcher/chunker` ≥ 95%, `watcher/loop` ≥ 80%, `watcher/resolve` ≥ 85% (mostly inherits from wizard's existing test depth).

### Test layers

| Layer | Scope | Tools |
|---|---|---|
| Unit | per-package pure functions | stdlib `testing` + `t.TempDir()` |
| Integration (hermetic) | `Loop.Tick` end-to-end with fake sources + capture sink | stdlib |
| Smoke (manual, not CI) | `caliber-agent run --once` against real `~/.claude` | `agent/scripts/smoke-run.sh` |

### `sink`

- `log_test.go`:
  - Happy: `bytes.Buffer` writer + sample Chunk → assert log line shape + all metadata fields present.
  - **Privacy regression guard**: `Events: []string{"my-fake-cda_test_should_never_appear"}` → assert that string is NOT in the buffer output. Defends against future edits that print content.
  - Now-injection: assert timestamp matches injected time.

### `watcher/sources`

- `claude_test.go`:
  - `t.TempDir()` fixture: 2 main sessions, 1 with `subagents/agent-X.jsonl`, 1 dir without leading `-`, 1 non-`.jsonl` stray file → assert exact ref list + correct SessionID + correct ParentSessionID for subagent + Source values.
- `codex_test.go`:
  - `t.TempDir()` fixture: `2026/05/21/rollout-...-uuidA.jsonl` and `2026/04/01/rollout-...-uuidB.jsonl` and `2026/05/21/not-a-rollout.txt` (skipped) and `not-a-date-dir/x.jsonl` (skipped) → assert 2 refs returned + correct UUIDs extracted.

### `watcher/tail`

- Happy: seed file with `{"a":1}\n{"b":2}\n` from offset 0 → `Events=[{"a":1},{"b":2}]`, `ToOffset=14`.
- Tail from middle: seed with two lines, call `Read(path, 7)` → only the second line, `ToOffset=14`.
- Incomplete trailing: seed `{"a":1}\n{"b":2` (no trailing `\n`) → only first line returned; `ToOffset=8` (after first `\n`); second-line bytes NOT consumed.
- Empty lines: seed `{"a":1}\n\n  \n{"b":2}\n` → 2 events, `Skipped=2`, `ToOffset` covers all bytes.
- Shrank: pre-seed offset=10000, file size=100 → returns `ErrFileShrank`.
- Oversize line dropped: seed a single line of 5 MiB (>4 MiB cap) followed by `\n{"a":1}\n` → `Events=[{"a":1}]`, `OversizeDropped=1`, `ToOffset` covers ALL bytes including the dropped line.
- Per-tick byte budget hit: seed 20 MiB of small JSONL events → `TickBudgetHit=true`, `cumulativeEventBytes <= maxTickBytes + one line slack`, `ToOffset` reflects exactly what was consumed.
- Memory bound assertion: open through a counting wrapper, run Read on a 50 MiB file → assert reader bytes-consumed never exceeds `maxTickBytes + 1 MiB` (the bufio buffer + one in-flight line).
- Gone: missing file → returns `ErrFileGone`.
- Injected Open: byte-counting reader wrapper; assert Tail reads at most `size − fromOffset` bytes (no overscan).

### `watcher/chunker`

- Happy: 1 ref + non-empty TailResult → 1 Chunk with all fields populated from inputs.
- Empty TailResult (no events, ToOffset == FromOffset): 0 chunks returned (loop short-circuits earlier, but this is defensive).

### `watcher/resolve`

- Re-uses wizard's existing test fixtures (or imports them — extract once, test in both places). Specifically: dashed-real-cwd, clean-cwd, byte-budget-exhausted, giant-single-line. The greedyDecode pair is tested via the wizard's tests for backwards compatibility (don't duplicate).

### `watcher/loop`

- All tests use `t.TempDir()` for HOME, `t.Setenv` for env overrides, fake `Source`/`Sink`/`Logger`, injected `Now`.
- Happy:
  - 1 fake Source emitting 2 refs (one with new bytes, one with no new bytes).
  - Allow-list contains the cwd for both.
  - assert FakeSink received 1 Chunk (for the ref with new bytes), State.Files has 1 advanced entry, log has 1 `[chunk]` line + 1 `[tick-end]`.
- Allow-list filter:
  - 3 refs, only 1 cwd is in `cfg.IncludePaths` → only that ref is tailed; the other 2 are not opened (assert via byte-counter on Tailer.Open).
- Failure A (file gone):
  - Fake Source emits a ref whose Path doesn't exist → log `[warn] file gone`, no Sink call, State unchanged.
- Failure B (file shrank):
  - Pre-seed state.json with offset=1000, real file size=10 (with `{"a":1}\n` content) → assert tail resets to 0, Chunk delivered with FromOffset=0, log has `[warn] file shrank`, State advances.
- Failure B' (shrank to empty — regression for round-3 review):
  - Pre-seed state.json with offset=1000, then truncate file to 0 bytes → first tick: ErrFileShrank → State.Files[path].Offset persisted to 0 BEFORE re-tail → re-tail returns empty TailResult → next tick stat sees size==0 matches state offset==0, no ErrFileShrank loop.
- Failure B'' (shrank to incomplete line):
  - Pre-seed offset=1000, truncate to `{"a":1` (no trailing `\n`, 6 bytes) → first tick: ErrFileShrank → persist offset=0 → re-tail produces TailResult with `Events=[]` and `ToOffset=0` (incomplete trailing line dropped) → State stays at offset 0, no infinite loop.
- Failure C (sink error):
  - `FakeSink.Err = errors.New("disk full")` → assert State.Files untouched, log has `[error] sink`, Tick still returns nil.
- Failure D (cwd unresolvable):
  - Inject a CWDResolver that returns "" → assert ref skipped, State unchanged.
  - **Cache assertion**: tick twice with the same unresolved ref → assert ResolveClaude is called twice (no negative caching).
- Whitespace-only segment advances watermark:
  - Seed file with `\n\n  \n` after the watermark, no real events → assert FakeSink received 0 chunks, State.Files[path].Offset advanced to file size, log has no `[chunk]` line but DOES have `[tick-end] chunks=0 errors=0` and the SaveState path was hit (verify by tick-twice: second tick reads zero new bytes and short-circuits).
- cwdCache regression:
  - First tick resolves ref's cwd via ResolveClaude (counting Resolver calls); second tick with same ref → 0 additional Resolver calls (cache hit).
- Failure F (SIGTERM mid-tick):
  - Use `context.WithCancel`. Inject a FakeSink whose SendChunk callback cancels ctx on the 2nd call → assert 2nd call completes (in-flight), 3rd ref is NOT processed, SaveState called, Tick returns `ctx.Err()`.
- `[tick-end]` summary:
  - assert it logs the right counts (refs / chunks / errors / duration).

### `config/log`

- `t.TempDir()` HOME → `OpenAgentLog()` → file at `<HOME>/agent.log`, perm 0600, append-mode (close, reopen, write more, assert content concatenated).
- `RFCLogger.Printf` with injected Now → assert output line matches regex `^2026-05-22T\d{2}:\d{2}:\d{2}Z (...) \n` and contains the printf-rendered payload exactly once.
- `RFCLogger.Printf` with multi-arg format → assert args are interpolated before timestamp prepending (no double-formatting).

### `cli/run`

- Happy `--once`:
  - Pre-enroll (fake security + tmp HOME + seeded config.toml + seeded keychain) + fake `~/.claude/projects/` tree → run `caliber-agent run --once` → exit 0, agent.log has `[chunk]`, state.json advances.
- Not enrolled:
  - No config → `run --once` → exit 1, stderr contains "device not enrolled".
- Keychain missing:
  - Config present, no keychain entry → exit 1, stderr contains "device key missing".
- Persistent mode with quick interval:
  - `run --interval 100ms` + `context.WithTimeout(300ms)` → daemon runs ~3 ticks, ctx cancels, exit 130, state.json reflects multiple advances.

### What is intentionally NOT tested

- Real 60s wait (use `--interval 100ms` in all tests)
- launchd integration (PR4)
- Real `~/.claude` content (smoke script only)
- HTTP ingest (PR3)

### Coverage gate + CI

`agent/scripts/coverage.sh` and `.github/workflows/agent-ci.yml` from PR1 do not need to change. New packages flow into the gate automatically. Expected overall coverage: ~84-86% (similar to PR1's 84.5%; new package volumes balance out).

### Smoke script

`agent/scripts/smoke-run.sh`:

```bash
#!/usr/bin/env bash
# Manual smoke for the daemon main loop.
# Prereq: caliber-agent enroll already succeeded against a running stack;
#         caliber-agent add-path <some-project> has been used to populate
#         include_paths (until add-path is implemented in PR4, hand-edit
#         ~/.caliber-agent/config.toml).
# Not in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

go build -o /tmp/caliber-agent-smoke ./cmd/caliber-agent

/tmp/caliber-agent-smoke run --once

echo "--- last 20 agent.log lines ---"
tail -20 "$HOME/.caliber-agent/agent.log"
echo "--- state.json ---"
cat "$HOME/.caliber-agent/state.json" | python3 -m json.tool | head -40

rm /tmp/caliber-agent-smoke
echo "PASS: tick completed"
```

---

## 8. Public Contract (frozen at PR2)

These surfaces lock once PR2 merges. Future PRs evolve, not break.

- **New environment variables**
  - `CALIBER_CODEX_SESSIONS` — override `~/.codex/sessions` (test-only; undocumented in `--help`)
- **New CLI subcommand:** `caliber-agent run`
  - `--once` — run a single Tick then exit
  - `--interval DURATION` — polling interval (default 60s; documented but marked "advanced")
- **New exit codes:** none (reuses PR1's 0 / 1 / 70 / 130)
- **`agent.log` path** `~/.caliber-agent/agent.log`, append-only, 0600
- **`state.json`** semantics:
  - `Files[path].Offset` is the byte position from which the NEXT tail should read
  - `Files[path].LastSync` is the UTC timestamp of the most recent successful watermark advance for that file (sink ACK, whitespace-only advance, or shrink reset)
- **Sink interface + Chunk type** locked at PR2 boundaries (see §4.1 / §4.2). PR3 only evolves `Chunk.Events` from `[]string` to `[]Event`.

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Codex deep-nested layout changes between codex CLI versions | The `[0-9]{4}/[0-9]{2}/[0-9]{2}` matcher is structural; if codex changes (e.g., to single-flat-dir), the source's `List` returns empty and the daemon degrades gracefully — log a `[warn]` once per tick if 0 refs. |
| `agent.log` grows unbounded in PR2 | Documented out-of-scope; Phase 3 rotation. Operators can `truncate -s 0` while daemon is running (append-mode tolerates this — next write resumes appending). |
| 60s polling misses very short-lived sessions | LLM sessions are inherently slow (human-paced). Worst case: user closes session, daemon picks it up within 60s. Acceptable. |
| Multiple agent processes from launchd accident (PR4 not yet here) | PR2 doesn't write a lockfile. PR4's launchd plist enforces single-instance. PR2 manual `run` is foreground, so accidentally starting two terminals would produce duplicate sink calls but no corruption (atomic SaveState; at-least-once contract holds). |
| `--interval 100ms` flag enables abusive polling in production | Flag is documented; defaults to 60s; nothing prevents misuse. Phase 3 may move it behind a build tag or `--experimental` namespace. |
| Tail's "drop trailing incomplete line" misses the LAST event when a session ends mid-write | The session-ending write to JSONL is atomic at the OS level (write(2) of one full line). If a session ends and the file is closed mid-line, that line is lost on first tail; the next tail (60s later) sees the file unchanged (still no `\n` after the half-line) and continues to skip. Acceptable for PR2; rare in practice. PR3 may add EOF-stale detection if dogfood shows this matters. |

---

## 10. Out of Scope (with pointers to future PRs)

| Item | Future PR |
|---|---|
| `POST /v1/ingest` HTTP client with retry/backoff | PR3 |
| Redaction layer (metadata-only / redacted-body / full-body) | PR3 |
| Per-org redaction set fetch (enrollment + 24h cron) | PR3 |
| gzip chunk encoding | PR3 |
| launchd plist + `install-launchd` command | PR4 |
| Real implementations of `status` / `pause` / `resume` / `set-mode` / `add-path` / `remove-path` / `uninstall` | PR4+ |
| Homebrew tap push automation | PR4 |
| Linux build target | Phase 5+ |
| `agent.log` rotation | Phase 3 |
| `--repair-state` for corrupted state.json | Phase 3 |
| `vacuum`/cleanup of stale State entries | Phase 3 |

---

## 11. References

- Parent spec: `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` §"Phase 2 — Daemon MVP" (lines 549-562 + Daemon design §)
- PR1 spec: `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md` (§4.5 wizard, §4.6 cli, §7 testing, §8 frozen contract — all referenced)
- Claude transcript layout verified 2026-05-21 against `~/.claude/projects/` on dev workstation
- Codex transcript layout verified 2026-05-21 against `~/.codex/sessions/` (3-level YYYY/MM/DD nesting)
