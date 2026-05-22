# caliber-agent Phase 2 PR2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land caliber-agent Phase 2 PR2 — `caliber-agent run`, a foreground daemon loop that polls `~/.claude/projects/` and `~/.codex/sessions/` every 60s, tails new bytes per file, chunks them, and delivers each chunk to a `Sink`. Ships a stub `LogSink` (metadata-only to `agent.log`) so the daemon advances watermarks end-to-end. PR3 will swap in the real HTTP ingest client.

**Architecture:** Two new packages (`watcher`, `sink`), one new file in `config` (`log.go`), and a real `cli/run.go` replacing PR1's stub. Polling-only (60s tick), `io.LimitReader`-bounded tail reads (4 MiB/line, 16 MiB/file/tick, hard 20 MiB I/O), per-file watermark advance on three events (sink ACK / no-event consumed segment / shrink reset), each atomically persisted. Sink contract frozen at this PR so PR3 only swaps implementations.

**Tech Stack:** Go 1.25 (existing module), Cobra (PR1), BurntSushi/toml (PR1), stdlib `testing`. No new third-party deps in PR2.

**Authoritative spec:** `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md`. Spec wins over plan if they disagree — flag the discrepancy.

**Depends on:** PR #160 (`feat(agent): Phase 2 PR1 — scaffold + enroll end-to-end`). PR2 is **stacked on the PR1 branch** (`feat/caliber-agent-phase2-pr1`) so work can start before PR1 merges. After #159 + #160 merge to main, GitHub will auto-retarget PR2 to main; until then PR2's PR base is `feat/caliber-agent-phase2-pr1`.

---

## Phase 0 — Worktree setup

### Task 0.1: Create stacked-on-PR1 worktree

PR #160 is **not yet merged**. PR2 stacks on the PR1 branch so work can proceed in parallel.

- [ ] **Step 1: Update local PR1 branch tip**

```bash
cd /Users/hanfourhuang/ai-dev-eval
git fetch origin feat/caliber-agent-phase2-pr1
git branch -f feat/caliber-agent-phase2-pr1 origin/feat/caliber-agent-phase2-pr1
```

(`git branch -f` is safe here because the local branch tracks origin and we just want to fast-forward it to match.) Expected: local `feat/caliber-agent-phase2-pr1` now at the same commit as origin (currently `266d73c` per the PR1 work; whatever's there).

- [ ] **Step 2: Create the worktree branched from PR1 tip**

The cleanest way: `git worktree add` directly with the explicit base ref:

```bash
cd /Users/hanfourhuang/ai-dev-eval
git worktree add .claude/worktrees/feat-caliber-agent-phase2-pr2 \
    -b feat/caliber-agent-phase2-pr2 feat/caliber-agent-phase2-pr1
cd .claude/worktrees/feat-caliber-agent-phase2-pr2
```

If using EnterWorktree (which branches from local HEAD by default), first `git checkout feat/caliber-agent-phase2-pr1` in the main worktree, THEN `EnterWorktree name=feat-caliber-agent-phase2-pr2` — but the explicit `git worktree add` is simpler.

Verify:

```bash
git branch --show-current
# expected: feat/caliber-agent-phase2-pr2
git log --oneline -3
# expected: tip matches PR1's HEAD (currently 266d73c or later)
```

- [ ] **Step 3: Verify baseline tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./... -race
```

Expected: all PR1 tests pass.

```bash
./scripts/coverage.sh
```

Expected: coverage ≥ 80% (PR1 baseline).

---

## Phase 1 — `sink` package (frozen Chunk + Sink interface + LogSink)

This package is foundational and has no dependencies on other PR2 code. Land it first so later packages can import it.

### Task 1.1: Chunk type

**Files:**
- Create: `agent/sink/chunk.go`

- [ ] **Step 1: Create the package directory**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2
mkdir -p agent/sink
```

- [ ] **Step 2: Create `agent/sink/chunk.go`**

```go
// Package sink defines the contract between the watcher loop and any
// "send a chunk somewhere" implementation. PR2 ships a stub LogSink;
// PR3 replaces it with a real HTTP ingest client. The Chunk type and
// Sink interface are frozen at PR2 (spec §4.1, §4.2).
package sink

import "context"

// Chunk is the unit of work passed from the watcher loop to a Sink.
// FromOffset/ToOffset bracket the CONSUMED byte range for the file —
// not "before/after events". This is load-bearing because Tail may
// advance offsets over whitespace or oversize-dropped bytes that are
// NOT in Events. PR3 server-side dedupe keys on (session_id,
// event_uuid), not byte offsets.
type Chunk struct {
	File            string   // absolute path of the source transcript
	Source          string   // "claude" | "claude-subagent" | "codex"
	SessionID       string
	ParentSessionID string   // claude-subagent only; "" otherwise
	CWD             string   // resolved cwd at scan time (must be in cfg.IncludePaths)
	Events          []string // raw JSONL event lines, '\n' stripped (whitespace + oversize lines NOT included)
	FromOffset      int64    // consumed-byte range start; equals watermark before this tail run
	ToOffset        int64    // consumed-byte range end; loop advances watermark to this
}

// Sink is the seam between watcher and ingest. PR3 swaps the impl.
type Sink interface {
	// SendChunk delivers c. On nil error the loop advances
	// state.Files[c.File].Offset to c.ToOffset and persists state.
	// On non-nil error the watermark stays put; the loop retries next tick.
	SendChunk(ctx context.Context, c Chunk) error
}
```

- [ ] **Step 3: Verify package compiles**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go build ./sink/...
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add agent/sink/chunk.go
git commit -m "feat(agent): add sink.Chunk type with frozen contract for PR3"
```

### Task 1.2: LogSink with privacy and failing-writer guards

**Files:**
- Create: `agent/sink/log.go`
- Create: `agent/sink/log_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/sink/log_test.go`:

```go
package sink

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func fixedNow(s string) func() time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return func() time.Time { return t }
}

func TestLogSink_Happy_EmitsMetadataLine(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	s.Now = fixedNow("2026-05-22T10:00:00Z")

	err := s.SendChunk(context.Background(), Chunk{
		File:       "/Users/h/.claude/projects/-Users-h-proj/sess.jsonl",
		Source:     "claude",
		SessionID:  "sess-1",
		CWD:        "/Users/h/proj",
		Events:     []string{`{"a":1}`, `{"b":2}`, `{"c":3}`},
		FromOffset: 100,
		ToOffset:   300,
	})
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	got := buf.String()
	for _, want := range []string{
		"2026-05-22T10:00:00Z",
		"[chunk]",
		"source=claude",
		"file=/Users/h/.claude/projects/-Users-h-proj/sess.jsonl",
		"session=sess-1",
		"cwd=/Users/h/proj",
		"events=3",
		"bytes=100-300",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("log missing %q in %q", want, got)
		}
	}
}

func TestLogSink_Privacy_NoEventContentInOutput(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	const canary = "my-fake-cda_test_should_never_appear"
	err := s.SendChunk(context.Background(), Chunk{
		Events: []string{canary, "another event"},
	})
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	if strings.Contains(buf.String(), canary) {
		t.Errorf("privacy guard violated: event content %q leaked to log: %q", canary, buf.String())
	}
}

type failingWriter struct{ err error }

func (w *failingWriter) Write(_ []byte) (int, error) { return 0, w.err }

func TestLogSink_FailingWriter_ReturnsWrappedError(t *testing.T) {
	w := &failingWriter{err: errors.New("disk full")}
	s := NewLogSink(w)
	err := s.SendChunk(context.Background(), Chunk{
		File:     "/x",
		Events:   []string{"a"},
		ToOffset: 10,
	})
	if err == nil {
		t.Fatal("expected non-nil error from failing writer")
	}
	if !strings.Contains(err.Error(), "disk full") {
		t.Errorf("error should wrap underlying cause, got: %v", err)
	}
}

func TestLogSink_NowInjection(t *testing.T) {
	var buf bytes.Buffer
	s := NewLogSink(&buf)
	s.Now = fixedNow("2026-01-15T03:30:45Z")
	_ = s.SendChunk(context.Background(), Chunk{})
	if !strings.HasPrefix(buf.String(), "2026-01-15T03:30:45Z ") {
		t.Errorf("timestamp wrong: %q", buf.String())
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./sink/...
```

Expected: FAIL — `NewLogSink` undefined.

- [ ] **Step 3: Implement `agent/sink/log.go`**

```go
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
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./sink/... -v -race
```

Expected: all four tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/sink/log.go agent/sink/log_test.go
git commit -m "feat(agent): LogSink stub with privacy + failing-writer regression guards"
```

---

## Phase 2 — `config/log.go` (OpenAgentLog + RFCLogger)

Two tightly-paired pieces in one file: open the append-only `agent.log` handle at 0600, plus a small `RFCLogger` that emits the `<UTC-RFC3339> <payload>\n` line format the spec freezes.

### Task 2.1: OpenAgentLog

**Files:**
- Create: `agent/internal/config/log.go`
- Create: `agent/internal/config/log_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/config/log_test.go`:

```go
package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenAgentLog_CreatesAt0600(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("OpenAgentLog: %v", err)
	}
	defer f.Close()

	info, err := os.Stat(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

func TestOpenAgentLog_AppendsAcrossReopens(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f1, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if _, err := f1.WriteString("line-1\n"); err != nil {
		t.Fatal(err)
	}
	f1.Close()

	f2, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if _, err := f2.WriteString("line-2\n"); err != nil {
		t.Fatal(err)
	}
	f2.Close()

	bs, err := os.ReadFile(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(bs)
	if !strings.Contains(got, "line-1") || !strings.Contains(got, "line-2") {
		t.Errorf("expected both lines, got %q", got)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/config/... -run OpenAgentLog
```

Expected: FAIL — `OpenAgentLog` undefined.

- [ ] **Step 3: Implement OpenAgentLog (partial file — RFCLogger added in Task 2.2)**

Create `agent/internal/config/log.go`:

```go
package config

import "os"

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
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/config/... -v
```

Expected: both new tests pass; all PR1 config tests still pass.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/log.go agent/internal/config/log_test.go
git commit -m "feat(agent): OpenAgentLog (0600, append-mode) for daemon stdout-replacement"
```

### Task 2.2: RFCLogger

**Files:**
- Modify: `agent/internal/config/log.go` (append RFCLogger)
- Modify: `agent/internal/config/log_test.go` (append tests)

- [ ] **Step 1: Append failing tests to `log_test.go`**

Append to `agent/internal/config/log_test.go`:

```go
import "bytes"
import "regexp"
import "time"

func TestRFCLogger_PrependsTimestamp(t *testing.T) {
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	l.Now = func() time.Time {
		return time.Date(2026, 5, 22, 11, 14, 2, 0, time.UTC)
	}
	l.Printf("[chunk] file=%s events=%d", "/tmp/x", 3)
	got := buf.String()
	if got != "2026-05-22T11:14:02Z [chunk] file=/tmp/x events=3\n" {
		t.Errorf("got %q", got)
	}
}

func TestRFCLogger_RFC3339UTC_RegexMatch(t *testing.T) {
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	// default Now -> real time.Now; just check format shape.
	l.Printf("hello")
	got := buf.String()
	re := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z hello\n$`)
	if !re.MatchString(got) {
		t.Errorf("output doesn't match RFC3339 UTC pattern: %q", got)
	}
}

func TestRFCLogger_ArgsInterpolatedOnce(t *testing.T) {
	// Guard: if the implementation formatted twice (e.g. by accident
	// using Sprintf then Fprintf with format-rendered string), %d-like
	// directives in user data could double-expand.
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	l.Now = func() time.Time { return time.Unix(0, 0).UTC() }
	l.Printf("payload=%s", "100%% complete")
	got := buf.String()
	if !regexp.MustCompile(`payload=100%% complete\n$`).MatchString(got) {
		t.Errorf("args double-formatted: %q", got)
	}
}
```

Note: in real Go test code the imports are usually merged into one block at the top. The new imports are listed above for clarity; merge them into the existing import block of `log_test.go`.

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/config/... -run RFCLogger
```

Expected: FAIL — `NewRFCLogger` undefined.

- [ ] **Step 3: Append RFCLogger to `log.go`**

Append to `agent/internal/config/log.go`:

```go
import (
	"fmt"
	"io"
	"time"
)

// RFCLogger formats every line as "<UTC-RFC3339> <printf-rendered>\n".
//
// Why a custom logger instead of stdlib log.New(...):
//   log.LstdFlags|log.LUTC emits "YYYY/MM/DD HH:MM:SS" which violates the
//   §5 frozen external contract requiring UTC-RFC3339 line format. This
//   tiny wrapper is the simplest way to comply without pulling in a
//   logging library.
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
```

Note: merge the new imports (`fmt`, `io`, `time`) with the existing `import "os"` line into a single import block.

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/config/... -v
```

Expected: 5 tests pass (2 OpenAgentLog + 3 RFCLogger) plus all PR1 config tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/log.go agent/internal/config/log_test.go
git commit -m "feat(agent): RFCLogger so daemon logs match the UTC-RFC3339 contract"
```

---

## Phase 3 — `watcher/sources` (FileRef + ClaudeSource + CodexSource)

Two source implementations behind one interface. Claude leaves `FileRef.CWD` empty (the loop calls `CWDResolver`); Codex populates it cheaply from the first-line `session_meta` event.

### Task 3.1: FileRef + Source interface

**Files:**
- Create: `agent/watcher/sources.go`

- [ ] **Step 1: Create the package directory**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2
mkdir -p agent/watcher
```

- [ ] **Step 2: Create `agent/watcher/sources.go`**

```go
// Package watcher polls source transcript directories, tails new bytes,
// chunks them, and delivers chunks to a Sink. The package is structured
// so PR3 can swap the sink implementation without touching the tailer
// or the source-discovery code.
package watcher

import "context"

// FileRef is one transcript file discovered by a Source. CWD is
// populated by sources that know the cwd cheaply (codex via
// session_meta); claude leaves it empty and the loop calls
// CWDResolver. See spec §4.3.
type FileRef struct {
	Path            string // absolute
	Source          string // "claude" | "claude-subagent" | "codex"
	SessionID       string
	ParentSessionID string // empty unless Source == "claude-subagent"
	CWD             string // empty for claude (resolver fills); cheap for codex
}

// Source enumerates files under one root. It does not open them for
// content beyond what the source layout requires for cwd extraction
// (codex reads the first line; claude does not open files in List).
type Source interface {
	Name() string                              // for logs
	List(ctx context.Context) ([]FileRef, error)
}
```

- [ ] **Step 3: Verify package compiles**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go build ./watcher/...
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add agent/watcher/sources.go
git commit -m "feat(agent): watcher.FileRef + Source interface"
```

### Task 3.2: ClaudeSource

**Files:**
- Create: `agent/watcher/claude.go`
- Create: `agent/watcher/claude_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/watcher/claude_test.go`:

```go
package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path string, content string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeSource_ListMainAndSubagent(t *testing.T) {
	root := t.TempDir()

	// Project A: 2 main sessions, 1 has a subagent
	proj := filepath.Join(root, "-Users-h-proj")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000001.jsonl"), "{}\n")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000002.jsonl"), "{}\n")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000001", "subagents",
		"agent-abc123.jsonl"), "{}\n")

	// Skipped: dir without leading "-"
	write(t, filepath.Join(root, "not-a-claude-project", "x.jsonl"), "{}\n")

	// Skipped: non-jsonl file in a real project dir
	write(t, filepath.Join(proj, "README.md"), "x")

	s := NewClaudeSource(root)
	if s.Name() != "claude" {
		t.Errorf("Name() = %q, want %q", s.Name(), "claude")
	}

	refs, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(refs) != 3 {
		t.Fatalf("got %d refs, want 3 (2 main + 1 subagent): %+v", len(refs), refs)
	}

	// Index by path for stable assertions.
	byPath := map[string]FileRef{}
	for _, r := range refs {
		byPath[r.Path] = r
	}

	main1 := byPath[filepath.Join(proj, "00000000-0000-0000-0000-000000000001.jsonl")]
	if main1.Source != "claude" {
		t.Errorf("main1 source = %q", main1.Source)
	}
	if main1.SessionID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("main1 SessionID = %q", main1.SessionID)
	}
	if main1.ParentSessionID != "" {
		t.Errorf("main1 ParentSessionID should be empty, got %q", main1.ParentSessionID)
	}
	if main1.CWD != "" {
		t.Errorf("main1 CWD should be empty (filled by resolver), got %q", main1.CWD)
	}

	subPath := filepath.Join(proj, "00000000-0000-0000-0000-000000000001", "subagents",
		"agent-abc123.jsonl")
	sub := byPath[subPath]
	if sub.Source != "claude-subagent" {
		t.Errorf("sub source = %q", sub.Source)
	}
	if sub.SessionID != "abc123" {
		t.Errorf("sub SessionID = %q, want %q", sub.SessionID, "abc123")
	}
	if sub.ParentSessionID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("sub ParentSessionID = %q", sub.ParentSessionID)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Claude
```

Expected: FAIL — `NewClaudeSource` undefined.

- [ ] **Step 3: Implement `agent/watcher/claude.go`**

```go
package watcher

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// ClaudeSource walks ~/.claude/projects/ and yields one FileRef per
// transcript: main sessions at <root>/<encoded-cwd>/*.jsonl plus any
// subagent sessions at <root>/<encoded-cwd>/<sessionID>/subagents/agent-*.jsonl.
//
// FileRef.CWD is intentionally left empty. The loop's CWDResolver
// resolves it per-DIR (cached) because all sessions in the same
// <encoded-cwd>/ share the same cwd, and the dirname-decode is lossy
// for paths with native hyphens (see spec §4.5 / wizard.ScanClaudeProjects).
type ClaudeSource struct {
	Root string
}

func NewClaudeSource(root string) *ClaudeSource { return &ClaudeSource{Root: root} }

func (s *ClaudeSource) Name() string { return "claude" }

func (s *ClaudeSource) List(ctx context.Context) ([]FileRef, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var refs []FileRef
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), "-") {
			continue
		}
		projDir := filepath.Join(s.Root, e.Name())
		// Main sessions: <projDir>/*.jsonl
		mainEntries, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, m := range mainEntries {
			if m.IsDir() {
				// Possibly a <sessionID> dir holding subagents.
				continue
			}
			if filepath.Ext(m.Name()) != ".jsonl" {
				continue
			}
			sessionID := strings.TrimSuffix(m.Name(), ".jsonl")
			refs = append(refs, FileRef{
				Path:      filepath.Join(projDir, m.Name()),
				Source:    "claude",
				SessionID: sessionID,
			})
		}
		// Subagents: <projDir>/<sessionID>/subagents/agent-*.jsonl
		for _, m := range mainEntries {
			if !m.IsDir() {
				continue
			}
			subDir := filepath.Join(projDir, m.Name(), "subagents")
			subEntries, err := os.ReadDir(subDir)
			if err != nil {
				continue // most session dirs have no subagents/ subdir
			}
			for _, s := range subEntries {
				if s.IsDir() {
					continue
				}
				name := s.Name()
				if !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".jsonl") {
					continue
				}
				agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
				refs = append(refs, FileRef{
					Path:            filepath.Join(subDir, name),
					Source:          "claude-subagent",
					SessionID:       agentID,
					ParentSessionID: m.Name(),
				})
			}
		}
	}
	return refs, nil
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/claude.go agent/watcher/claude_test.go
git commit -m "feat(agent): ClaudeSource — main + subagent walk with filename-derived IDs"
```

### Task 3.3: CodexSource (with 64 KiB bounded first-line read)

**Files:**
- Create: `agent/watcher/codex.go`
- Create: `agent/watcher/codex_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/watcher/codex_test.go`:

```go
package watcher

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCodexSource_ListFindsNestedRollouts(t *testing.T) {
	root := t.TempDir()
	uuidA := "019daa4d-9a43-7f71-8b69-10245f9970ac"
	uuidB := "019d9ef3-4b06-7372-b188-eb872d3f28e7"

	write(t, filepath.Join(root, "2026", "05", "21",
		"rollout-2026-05-21T10-00-00-"+uuidA+".jsonl"),
		`{"type":"session_meta","payload":{"id":"`+uuidA+`","cwd":"/Users/me/A"}}`+"\n")
	write(t, filepath.Join(root, "2026", "04", "01",
		"rollout-2026-04-01T09-00-00-"+uuidB+".jsonl"),
		`{"type":"session_meta","payload":{"id":"`+uuidB+`","cwd":"/Users/me/B"}}`+"\n")

	// Skipped: not a .jsonl in a real date dir
	write(t, filepath.Join(root, "2026", "05", "21", "not-a-rollout.txt"), "x")
	// Skipped: not a YYYY/MM/DD path
	write(t, filepath.Join(root, "not-a-date-dir", "x.jsonl"), "{}")

	s := NewCodexSource(root, nil) // nil opener -> default os.Open
	if s.Name() != "codex" {
		t.Errorf("Name() = %q", s.Name())
	}

	refs, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("got %d refs, want 2: %+v", len(refs), refs)
	}

	byID := map[string]FileRef{}
	for _, r := range refs {
		byID[r.SessionID] = r
	}
	if byID[uuidA].CWD != "/Users/me/A" {
		t.Errorf("uuidA CWD = %q", byID[uuidA].CWD)
	}
	if byID[uuidB].CWD != "/Users/me/B" {
		t.Errorf("uuidB CWD = %q", byID[uuidB].CWD)
	}
	if byID[uuidA].Source != "codex" {
		t.Errorf("uuidA source = %q", byID[uuidA].Source)
	}
	if byID[uuidA].ParentSessionID != "" {
		t.Errorf("uuidA ParentSessionID should be empty")
	}
}

func TestCodexSource_MissingPayloadCwd_LeavesCWDEmpty(t *testing.T) {
	root := t.TempDir()
	uuidX := "019ddead-0000-0000-0000-000000000000"
	write(t, filepath.Join(root, "2026", "05", "22",
		"rollout-2026-05-22T10-00-00-"+uuidX+".jsonl"),
		`{"type":"session_meta","payload":{"id":"`+uuidX+`"}}`+"\n")

	s := NewCodexSource(root, nil)
	refs, _ := s.List(context.Background())
	if len(refs) != 1 || refs[0].CWD != "" {
		t.Errorf("want one ref with empty CWD, got %+v", refs)
	}
}

func TestCodexSource_MalformedFirstLine_LeavesCWDEmptyNoPanic(t *testing.T) {
	root := t.TempDir()
	uuidX := "019ddead-0000-0000-0000-000000000001"
	write(t, filepath.Join(root, "2026", "05", "22",
		"rollout-x-"+uuidX+".jsonl"),
		"{this isn't valid json\n")

	s := NewCodexSource(root, nil)
	refs, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List should not error on malformed file: %v", err)
	}
	if len(refs) != 1 || refs[0].CWD != "" {
		t.Errorf("want one ref with empty CWD, got %+v", refs)
	}
}

type countingOpener struct {
	bytesRead *int64
}

func (c *countingOpener) Open(path string) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return &countingReader{r: f, n: c.bytesRead}, nil
}

type countingReader struct {
	r io.ReadCloser
	n *int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	atomic.AddInt64(c.n, int64(n))
	return n, err
}
func (c *countingReader) Close() error { return c.r.Close() }

func TestCodexSource_64KiBBound_OnUnboundedMalformedFirstLine(t *testing.T) {
	root := t.TempDir()
	uuidX := "019ddead-0000-0000-0000-000000000002"
	// 200 KiB of garbage, no newline. session_meta is unbounded JSON.
	garbage := strings.Repeat("x", 200*1024)
	write(t, filepath.Join(root, "2026", "05", "22",
		"rollout-x-"+uuidX+".jsonl"), garbage)

	var bytesRead int64
	s := NewCodexSource(root, (&countingOpener{bytesRead: &bytesRead}).Open)
	refs, _ := s.List(context.Background())
	if len(refs) != 1 || refs[0].CWD != "" {
		t.Errorf("want one ref with empty CWD, got %+v", refs)
	}
	if bytesRead > 64*1024 {
		t.Errorf("bytesRead = %d, want ≤ 64 KiB", bytesRead)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Codex
```

Expected: FAIL — `NewCodexSource` undefined.

- [ ] **Step 3: Implement `agent/watcher/codex.go`**

```go
package watcher

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const codexFirstLineCap = 64 * 1024 // bound the session_meta read

// CodexSource walks ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and
// populates FileRef.CWD by reading the first JSONL line as session_meta.
// Opener is injectable so tests can wrap the file with a byte counter.
type CodexSource struct {
	Root string
	open func(path string) (io.ReadCloser, error)
}

// NewCodexSource constructs a CodexSource. If openFn is nil, defaults
// to wrapping os.Open in an io.ReadCloser.
func NewCodexSource(root string, openFn func(path string) (io.ReadCloser, error)) *CodexSource {
	if openFn == nil {
		openFn = func(p string) (io.ReadCloser, error) {
			f, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			return f, nil
		}
	}
	return &CodexSource{Root: root, open: openFn}
}

func (s *CodexSource) Name() string { return "codex" }

var (
	yearRE  = regexp.MustCompile(`^[0-9]{4}$`)
	mmddRE  = regexp.MustCompile(`^[0-9]{2}$`)
	// rollout filename:  rollout-YYYY-MM-DDTHH-MM-SS-<UUID>.jsonl
	// We extract the UUID as the last "-"-separated token before ".jsonl".
	uuidExtractRE = regexp.MustCompile(`^rollout-.*-([0-9a-f-]+)\.jsonl$`)
)

func (s *CodexSource) List(ctx context.Context) ([]FileRef, error) {
	yearEntries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var refs []FileRef
	for _, ye := range yearEntries {
		if !ye.IsDir() || !yearRE.MatchString(ye.Name()) {
			continue
		}
		yearDir := filepath.Join(s.Root, ye.Name())
		monthEntries, err := os.ReadDir(yearDir)
		if err != nil {
			continue
		}
		for _, me := range monthEntries {
			if !me.IsDir() || !mmddRE.MatchString(me.Name()) {
				continue
			}
			monthDir := filepath.Join(yearDir, me.Name())
			dayEntries, err := os.ReadDir(monthDir)
			if err != nil {
				continue
			}
			for _, de := range dayEntries {
				if !de.IsDir() || !mmddRE.MatchString(de.Name()) {
					continue
				}
				dayDir := filepath.Join(monthDir, de.Name())
				fileEntries, err := os.ReadDir(dayDir)
				if err != nil {
					continue
				}
				for _, fe := range fileEntries {
					if fe.IsDir() || filepath.Ext(fe.Name()) != ".jsonl" {
						continue
					}
					if !strings.HasPrefix(fe.Name(), "rollout-") {
						continue
					}
					m := uuidExtractRE.FindStringSubmatch(fe.Name())
					var sessID string
					if len(m) == 2 {
						sessID = m[1]
					}
					path := filepath.Join(dayDir, fe.Name())
					refs = append(refs, FileRef{
						Path:      path,
						Source:    "codex",
						SessionID: sessID,
						CWD:       s.readCWD(path),
					})
				}
			}
		}
	}
	return refs, nil
}

// readCWD opens the file via the injectable opener, reads up to 64 KiB,
// parses as session_meta JSON, and returns payload.cwd. On any error
// (missing field, malformed, oversize), returns "".
func (s *CodexSource) readCWD(path string) string {
	rc, err := s.open(path)
	if err != nil {
		return ""
	}
	defer rc.Close()
	lr := io.LimitReader(rc, codexFirstLineCap)
	bs, err := io.ReadAll(lr)
	if err != nil {
		return ""
	}
	// session_meta is the WHOLE first line, terminated by '\n'.
	if nl := strings.IndexByte(string(bs), '\n'); nl >= 0 {
		bs = bs[:nl]
	}
	// If we didn't see a '\n', the line is incomplete (> 64 KiB). Try parsing
	// anyway — JSON decoder will likely fail, returning "" cleanly.
	var obj struct {
		Payload struct {
			CWD string `json:"cwd"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(bs, &obj); err != nil {
		return ""
	}
	return obj.Payload.CWD
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -v -race
```

Expected: all 4 codex tests pass + claude tests still green.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/codex.go agent/watcher/codex_test.go
git commit -m "feat(agent): CodexSource with 64 KiB-bounded session_meta cwd read"
```

---

## Phase 4 — `watcher/resolve` (CWDResolver extracted from wizard)

The wizard's `ScanClaudeProjects` already has the bounded-JSONL-primary + dirname-fallback algorithm. PR2 extracts the per-directory resolver into a reusable form so the loop can call it without pulling in the wizard's whole listing logic.

### Task 4.1: Refactor wizard to expose ResolveClaude(dir)

**Files:**
- Modify: `agent/internal/wizard/projects.go` (add `resolveOneClaudeDir` function; keep `ScanClaudeProjects` using it internally)
- Modify: `agent/internal/wizard/projects_test.go` (no changes — existing tests verify behaviour unchanged)
- Create: `agent/watcher/resolve.go`
- Create: `agent/watcher/resolve_test.go`

- [ ] **Step 1: Read the wizard's existing implementation**

Inspect `agent/internal/wizard/projects.go` and identify the function that, given one claude project dir, returns the cwd (currently embedded inside `ScanClaudeProjects`'s loop). It does:

1. Walk JSONL files newest-first
2. Wrap each in `io.LimitReader(f, perDirByteBudget)` where `perDirByteBudget = 256 KiB`
3. ReadSlice('\n') in a loop; on each line try to extract a stat-verified cwd
4. If JSONL scan exhausts without a cwd, fall back to `dirnameFallback` (stat-guided greedyDecode)

We need to expose this as a named function the watcher can also call.

- [ ] **Step 2: Add `resolveOneClaudeDir` to `agent/internal/wizard/projects.go`**

Extract the inner cwd-resolution logic into a function with this signature (do NOT change `ScanClaudeProjects` external behaviour; have it call the new helper for each dir):

```go
// resolveOneClaudeDir attempts to resolve cwd for a single Claude project
// dir. Returns ("", nil) if no resolution succeeded with no I/O error;
// ("", err) on I/O failure; (cwd, nil) on success.
//
// This is the shared engine used by ScanClaudeProjects and by the
// watcher loop (via watcher.CWDResolver). Algorithm matches the
// previously-inlined logic verbatim: JSONL primary + dirname fallback.
func resolveOneClaudeDir(dir string, open opener) (string, error) {
    // (move the existing inner-loop body here verbatim)
}
```

If `opener` is the existing wizard-package type, keep it package-private. The watcher will import a re-export below.

Adjust `ScanClaudeProjects` to call `resolveOneClaudeDir` per dir instead of inlining the algorithm. Existing tests must still pass.

Verify:

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/wizard/... -race
```

Expected: all wizard tests still pass.

- [ ] **Step 3: Expose the helper via an unexported package-level alias accessible to watcher**

Wizard's `resolveOneClaudeDir` is unexported. The watcher CANNOT import it directly. Three options:

A. Make it exported in `wizard`: `ResolveOneClaudeDir`. Pollutes wizard's public surface.
B. Copy the algorithm into `watcher/resolve.go`. Duplication.
C. Move the algorithm to a new neutral package `agent/internal/cwdresolve/` and have BOTH wizard and watcher import it.

Pick **C**. It's a tiny package and keeps both consumers honest.

- [ ] **Step 4: Create `agent/internal/cwdresolve/cwdresolve.go`**

Move the algorithm:

```go
// Package cwdresolve resolves the cwd of a Claude project directory.
// Used by both the wizard (during enroll for candidate listing) and the
// watcher loop (per-tick allow-list filtering). JSONL primary + dirname
// fallback, io.LimitReader-bounded.
package cwdresolve

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strings"
)

const perDirByteBudget = 256 * 1024 // shared with wizard's existing constant

// Opener returns an io.ReadCloser for a path. Production passes os.Open
// (wrapped to satisfy ReadCloser). Tests inject byte-counting wrappers.
type Opener func(path string) (io.ReadCloser, error)

// DefaultOpener wraps os.Open in an io.ReadCloser.
func DefaultOpener(p string) (io.ReadCloser, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// ResolveOneClaudeDir attempts to resolve the cwd for one Claude project
// dir. Return contract:
//   (cwd, nil)  — resolved; cwd is absolute and os.Stat'd as a directory
//   ("",  nil)  — no I/O error but no usable cwd found; caller skips
//   ("",  err)  — I/O failure; caller logs
//
// Algorithm: JSONL primary (newest *.jsonl first, total 256 KiB budget,
// per-line scan for {"cwd":"..."} that stats as a dir), then dirname
// fallback (greedy stat-guided dash-decode).
func ResolveOneClaudeDir(dir string, open Opener) (string, error) {
	if open == nil {
		open = DefaultOpener
	}

	// 1. JSONL primary.
	jsonls, err := listJSONLByMtimeDesc(dir)
	if err != nil {
		return "", err
	}
	budget := int64(perDirByteBudget)
	for _, path := range jsonls {
		if budget <= 0 {
			break
		}
		cwd, consumed, perr := scanFileForCWD(path, budget, open)
		budget -= consumed
		if perr != nil {
			// Open / read errors per file are non-fatal; keep going.
			continue
		}
		if cwd != "" {
			return cwd, nil
		}
	}

	// 2. Dirname fallback.
	base := filepath.Base(dir)
	if !strings.HasPrefix(base, "-") {
		return "", nil
	}
	return greedyDirnameDecode(base[1:])
}
```

(The implementation will need additional helper functions — `listJSONLByMtimeDesc`, `scanFileForCWD`, `greedyDirnameDecode` — moved over from wizard. Keep the algorithm verbatim; just relocate.)

You'll need `"path/filepath"` and any other imports the moved helpers require.

- [ ] **Step 5: Update wizard to use the new package**

In `agent/internal/wizard/projects.go`, replace the local `resolveOneClaudeDir` body with a one-line delegation:

```go
import "github.com/hanfour/ai-dev-eval/agent/internal/cwdresolve"

// (in ScanClaudeProjects's per-dir loop, replace the old inline code with:)
cwd, rerr := cwdresolve.ResolveOneClaudeDir(dir, cwdresolve.DefaultOpener)
```

Adjust `wizard`'s tests that injected a custom opener: they now construct a `cwdresolve.Opener` and pass it through to the underlying call.

Verify wizard still green:

```bash
go test ./internal/wizard/... -race
```

- [ ] **Step 6: Commit the extraction**

```bash
git add agent/internal/cwdresolve/ agent/internal/wizard/projects.go
git commit -m "refactor(agent): extract cwdresolve package for watcher reuse (no behaviour change)"
```

### Task 4.2: watcher.CWDResolver wrapper

**Files:**
- Create: `agent/watcher/resolve.go`
- Create: `agent/watcher/resolve_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/watcher/resolve_test.go`:

```go
package watcher

import (
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestCWDResolver_PassesThroughToPackage(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "proj")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Claude-encoded dir name: "/tmp/.../test/proj" → "-tmp-...-test-proj"
	claudeDir := filepath.Join(tmp, "claude-projects",
		"-"+filepath.ToSlash(realDir)[1:])
	// strip leading "/" and prepend "-"; turn other "/" into "-"
	// (just rebuild via strings for clarity)
	// — actually easier: use the encoding helper if you have one.
	// For this test, we'll do it manually:
	relPathInTmp := realDir // absolute
	encoded := "-" + relPathInTmp[1:]
	encoded = osPathToDashes(encoded)
	claudeDir = filepath.Join(tmp, "claude-projects", encoded)
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Empty subagents-like dir: no JSONL → forces fallback path
	r := NewCWDResolver(nil)
	got, err := r.ResolveClaude(claudeDir)
	if err != nil {
		t.Fatalf("ResolveClaude: %v", err)
	}
	if got != realDir {
		t.Errorf("got %q, want %q", got, realDir)
	}
}

// osPathToDashes replaces all "/" with "-" — matches Claude's encoding.
func osPathToDashes(s string) string {
	out := []byte(s)
	for i, b := range out {
		if b == '/' {
			out[i] = '-'
		}
	}
	return string(out)
}

type wrappedReader struct {
	r io.ReadCloser
	n *int64
}

func (w *wrappedReader) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	atomic.AddInt64(w.n, int64(n))
	return n, err
}
func (w *wrappedReader) Close() error { return w.r.Close() }

func TestCWDResolver_InjectableOpener(t *testing.T) {
	// Just verify Open is exercised. Behavioural correctness is covered
	// by the wizard's existing test suite for cwdresolve.
	var bytesRead int64
	opener := func(p string) (io.ReadCloser, error) {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		return &wrappedReader{r: f, n: &bytesRead}, nil
	}
	r := NewCWDResolver(opener)
	_, _ = r.ResolveClaude(t.TempDir())
	// No assertion on bytesRead here — t.TempDir is empty so 0 reads is
	// expected. The point is Open is wired through without panic.
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run CWDResolver
```

Expected: FAIL — `NewCWDResolver` undefined.

- [ ] **Step 3: Implement `agent/watcher/resolve.go`**

```go
package watcher

import (
	"io"

	"github.com/hanfour/ai-dev-eval/agent/internal/cwdresolve"
)

// CWDResolver wraps cwdresolve.ResolveOneClaudeDir for the watcher loop.
// The injectable Open is required because the loop tests want to assert
// the 256 KiB per-dir bound holds under the same byte-counter pattern
// the wizard tests use.
type CWDResolver struct {
	open cwdresolve.Opener
}

// NewCWDResolver constructs a resolver. If open is nil, the package
// default is used (wraps os.Open in io.ReadCloser).
func NewCWDResolver(open func(path string) (io.ReadCloser, error)) *CWDResolver {
	if open == nil {
		return &CWDResolver{open: cwdresolve.DefaultOpener}
	}
	return &CWDResolver{open: cwdresolve.Opener(open)}
}

// ResolveClaude returns the cwd for a Claude project directory.
// Three-state contract — same as cwdresolve.ResolveOneClaudeDir:
//   (cwd, nil)  resolved
//   ("",  nil)  no I/O error but no usable cwd
//   ("",  err)  I/O failure
func (r *CWDResolver) ResolveClaude(claudeProjDir string) (string, error) {
	return cwdresolve.ResolveOneClaudeDir(claudeProjDir, r.open)
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -v -race
go test ./internal/wizard/... -race
go test ./internal/cwdresolve/... -race
```

Expected: all three suites green.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/resolve.go agent/watcher/resolve_test.go
git commit -m "feat(agent): watcher.CWDResolver thin wrapper over cwdresolve"
```

---

## Phase 5 — `watcher/tail` (bounded reads, oversize/EOF precedence)

The most error-prone piece in PR2. The spec went through 7 rounds of review specifically over this code path. Pay attention to:

- TWO state vars: `lineBuf` (capped at maxLineBytes) AND `lineBufLen` (uncapped; classification key)
- ReadSlice loop bounded by `io.LimitReader(f, maxTickBytes + maxLineBytes)`
- `TickBudgetHit` set at function exit, unconditional
- EOF precedence: oversize-incomplete → ADVANCE; sub-cap incomplete → don't advance

### Task 5.1: TailResult + sentinels + Tailer struct skeleton

**Files:**
- Create: `agent/watcher/tail.go`
- Create: `agent/watcher/tail_test.go`

- [ ] **Step 1: Write the failing tests for sentinels + skeleton**

Create `agent/watcher/tail_test.go`:

```go
package watcher

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTailer_FileGone_ReturnsErrFileGone(t *testing.T) {
	tt := &Tailer{}
	_, err := tt.Read("/path/that/does/not/exist", 0)
	if !errors.Is(err, ErrFileGone) {
		t.Fatalf("err = %v, want ErrFileGone", err)
	}
}

func TestTailer_FileShrank_ReturnsErrFileShrank(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	_, err := tt.Read(path, 10000) // recorded watermark beyond file size
	if !errors.Is(err, ErrFileShrank) {
		t.Fatalf("err = %v, want ErrFileShrank", err)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Tailer_FileGone
```

Expected: FAIL — `Tailer` / `ErrFileGone` undefined.

- [ ] **Step 3: Create `agent/watcher/tail.go` skeleton**

```go
package watcher

import (
	"errors"
	"io"
	"os"
)

// Bounds for the tail loop. Both are file-level limits; cross-file
// budgets live in the loop.
const (
	maxLineBytes = 4 * 1024 * 1024  // 4 MiB; per-line in-memory cap on lineBuf
	maxTickBytes = 16 * 1024 * 1024 // 16 MiB; soft per-file per-tick budget on consumed bytes
)

// Sentinels for loop dispatch.
var (
	ErrFileGone   = errors.New("tail: file gone")
	ErrFileShrank = errors.New("tail: file shrank")
)

// TailResult is what Tail returns on a non-sentinel-error read.
type TailResult struct {
	Events          []string // raw JSONL event lines, '\n' stripped (whitespace + oversize NOT included)
	FromOffset      int64
	ToOffset        int64
	Skipped         int  // empty / whitespace-only completed lines
	OversizeDropped int  // lines whose size > maxLineBytes (completed OR oversize-at-EOF)
	TickBudgetHit   bool // consumed >= maxTickBytes at function exit
}

// Tailer reads new bytes from a file starting at fromOffset. Open and
// Stat are injectable for tests; production uses os.Open and a default
// stat function.
type Tailer struct {
	Open func(path string) (io.ReadSeekCloser, error) // default: os.Open
	Stat func(path string) (int64, error)             // default: os.Stat-based size
}

// Read is the entry point. See spec §4.6.
func (t *Tailer) Read(path string, fromOffset int64) (TailResult, error) {
	stat := t.Stat
	if stat == nil {
		stat = defaultStat
	}
	size, err := stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return TailResult{}, ErrFileGone
		}
		return TailResult{}, err
	}
	if size < fromOffset {
		return TailResult{}, ErrFileShrank
	}
	if size == fromOffset {
		return TailResult{FromOffset: fromOffset, ToOffset: fromOffset}, nil
	}
	// Real work in Task 5.2.
	return TailResult{}, errors.New("not implemented")
}

func defaultStat(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
```

- [ ] **Step 4: Verify the two skeleton tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run "Tailer_FileGone|Tailer_FileShrank" -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/tail.go agent/watcher/tail_test.go
git commit -m "feat(agent): tail.go skeleton — ErrFileGone, ErrFileShrank, TailResult"
```

### Task 5.2: The real ReadSlice loop (happy path + tail-from-middle + empty)

**Files:**
- Modify: `agent/watcher/tail.go` (replace the not-implemented stub)
- Modify: `agent/watcher/tail_test.go` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `agent/watcher/tail_test.go`:

```go
func TestTailer_Happy_TwoLinesFromZero(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte(`{"a":1}`+"\n"+`{"b":2}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 2 || r.Events[0] != `{"a":1}` || r.Events[1] != `{"b":2}` {
		t.Errorf("Events = %v", r.Events)
	}
	if r.ToOffset != 16 {
		t.Errorf("ToOffset = %d, want 16", r.ToOffset)
	}
}

func TestTailer_TailFromMiddle(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte(`{"a":1}`+"\n"+`{"b":2}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 8) // start after the first line's '\n'
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 1 || r.Events[0] != `{"b":2}` {
		t.Errorf("Events = %v", r.Events)
	}
	if r.ToOffset != 16 {
		t.Errorf("ToOffset = %d, want 16", r.ToOffset)
	}
	if r.FromOffset != 8 {
		t.Errorf("FromOffset = %d, want 8", r.FromOffset)
	}
}

func TestTailer_EmptyPostOffset(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 6) // size == fromOffset
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 0 || r.ToOffset != 6 {
		t.Errorf("expected empty TailResult at offset 6, got %+v", r)
	}
}

func TestTailer_IncompleteTrailingLine_DropsAndDoesNotAdvance(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte(`{"a":1}`+"\n"+`{"b":2`), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 1 || r.Events[0] != `{"a":1}` {
		t.Errorf("Events = %v", r.Events)
	}
	if r.ToOffset != 8 {
		t.Errorf("ToOffset = %d, want 8 (end of first '\\n')", r.ToOffset)
	}
}

func TestTailer_EmptyLines_AdvanceOffsetButNotInEvents(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	// {"a":1}\n\n  \n{"b":2}\n  → 2 events, 2 skipped, ToOffset covers all bytes
	if err := os.WriteFile(path, []byte(`{"a":1}`+"\n\n  \n"+`{"b":2}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 2 {
		t.Errorf("Events len = %d, want 2: %v", len(r.Events), r.Events)
	}
	if r.Skipped != 2 {
		t.Errorf("Skipped = %d, want 2", r.Skipped)
	}
	wantToOffset := int64(len(`{"a":1}` + "\n\n  \n" + `{"b":2}` + "\n"))
	if r.ToOffset != wantToOffset {
		t.Errorf("ToOffset = %d, want %d", r.ToOffset, wantToOffset)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Tailer
```

Expected: 5 tests fail (the "not implemented" placeholder).

- [ ] **Step 3: Replace the `not implemented` body**

In `agent/watcher/tail.go`, replace the `Read` body's tail (the `// Real work in Task 5.2.` section) with the full algorithm:

```go
func (t *Tailer) Read(path string, fromOffset int64) (TailResult, error) {
	stat := t.Stat
	if stat == nil {
		stat = defaultStat
	}
	size, err := stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return TailResult{}, ErrFileGone
		}
		return TailResult{}, err
	}
	if size < fromOffset {
		return TailResult{}, ErrFileShrank
	}
	if size == fromOffset {
		return TailResult{FromOffset: fromOffset, ToOffset: fromOffset}, nil
	}

	openFn := t.Open
	if openFn == nil {
		openFn = func(p string) (io.ReadSeekCloser, error) { return os.Open(p) }
	}
	f, err := openFn(path)
	if err != nil {
		return TailResult{}, err
	}
	defer f.Close()

	if _, err := f.Seek(fromOffset, io.SeekStart); err != nil {
		return TailResult{}, err
	}

	// Hard memory + I/O cap: 20 MiB per file per tick.
	lr := io.LimitReader(f, maxTickBytes+maxLineBytes)
	reader := bufio.NewReaderSize(lr, 64*1024)

	res := TailResult{FromOffset: fromOffset, ToOffset: fromOffset}
	var consumed int64
	var lineBuf []byte
	var lineBufLen int64

	classify := func() {
		// Called with lineBuf/lineBufLen representing a completed line
		// (trailing '\n' included in length but NOT in lineBuf content).
		// lineBuf has been trimmed of the trailing '\n' upstream.
		content := strings.TrimSpace(string(lineBuf))
		if lineBufLen-1 > int64(maxLineBytes) {
			// oversize-completed: drop content, but advance over its bytes.
			res.OversizeDropped++
		} else if content == "" {
			res.Skipped++
		} else {
			res.Events = append(res.Events, string(lineBuf))
		}
		res.ToOffset += lineBufLen
		lineBuf = lineBuf[:0]
		lineBufLen = 0
	}

	for {
		slice, err := reader.ReadSlice('\n')
		consumed += int64(len(slice))
		lineBufLen += int64(len(slice))

		// Append up to the in-memory cap; bytes beyond cap are dropped from
		// lineBuf but still counted in lineBufLen.
		if len(lineBuf) < maxLineBytes {
			room := maxLineBytes - len(lineBuf)
			toCopy := len(slice)
			if toCopy > room {
				toCopy = room
			}
			lineBuf = append(lineBuf, slice[:toCopy]...)
		}

		switch err {
		case nil:
			// Complete line ending in '\n'. Strip the newline from lineBuf
			// for classification.
			if n := len(lineBuf); n > 0 && lineBuf[n-1] == '\n' {
				lineBuf = lineBuf[:n-1]
			}
			classify()
			if consumed >= maxTickBytes {
				goto done
			}
		case bufio.ErrBufferFull:
			// Mid-line, no '\n' yet. lineBufLen continues growing
			// (uncapped). lineBuf cap has been enforced above.
			continue
		case io.EOF:
			// Three sub-cases per spec EOF precedence:
			if lineBufLen == 0 {
				// Clean end.
				goto done
			}
			if lineBufLen <= int64(maxLineBytes) {
				// Sub-cap incomplete trailing line: DROP, do NOT advance.
				goto done
			}
			// Oversize-and-incomplete: DROP content, DO advance.
			res.OversizeDropped++
			res.ToOffset += lineBufLen
			goto done
		default:
			return TailResult{}, err
		}
	}
done:
	res.TickBudgetHit = consumed >= maxTickBytes
	return res, nil
}
```

Add the missing imports to `tail.go`:

```go
import (
	"bufio"
	"errors"
	"io"
	"os"
	"strings"
)
```

- [ ] **Step 4: Verify the 5 happy-path / incomplete tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Tailer -v -race
```

Expected: 7 Tailer tests pass (2 from Task 5.1 + 5 here).

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/tail.go agent/watcher/tail_test.go
git commit -m "feat(agent): Tailer ReadSlice loop with whitespace+incomplete-trailing handling"
```

### Task 5.3: Oversize handling + TickBudgetHit + memory bound tests

**Files:**
- Modify: `agent/watcher/tail_test.go` (append all the round-3 to round-7 review-driven tests)

- [ ] **Step 1: Append the heavy tests**

Append to `agent/watcher/tail_test.go`:

```go
func TestTailer_Oversize_Completed_DropsAndAdvances(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	// 5 MiB line + '\n' + `{"a":1}` + '\n'
	huge := strings.Repeat("x", 5*1024*1024)
	if err := os.WriteFile(path, []byte(huge+"\n"+`{"a":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 1 || r.Events[0] != `{"a":1}` {
		t.Errorf("Events = %v", r.Events)
	}
	if r.OversizeDropped != 1 {
		t.Errorf("OversizeDropped = %d, want 1", r.OversizeDropped)
	}
}

func TestTailer_OversizeIncompleteAtEOF_DropsAndAdvances(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	huge := strings.Repeat("x", 5*1024*1024)
	if err := os.WriteFile(path, []byte(huge), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(r.Events) != 0 {
		t.Errorf("Events should be empty: %v", r.Events)
	}
	if r.OversizeDropped != 1 {
		t.Errorf("OversizeDropped = %d, want 1", r.OversizeDropped)
	}
	if r.ToOffset == 0 {
		t.Error("ToOffset should advance past dropped oversize bytes (forward progress)")
	}
}

func TestTailer_50MiBOversizeNoNewline_TickBudgetHitTrue(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	huge := strings.Repeat("x", 50*1024*1024) // 50 MiB no newline
	if err := os.WriteFile(path, []byte(huge), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !r.TickBudgetHit {
		t.Error("TickBudgetHit should be true (synthetic EOF from LimitReader at 20 MiB)")
	}
	if r.OversizeDropped != 1 {
		t.Errorf("OversizeDropped = %d, want 1", r.OversizeDropped)
	}
}

type countingFile struct {
	*os.File
	n *int64
}

func (c *countingFile) Read(p []byte) (int, error) {
	n, err := c.File.Read(p)
	atomic.AddInt64(c.n, int64(n))
	return n, err
}

func TestTailer_MemoryBoundRegression_50MiBFileReadsAtMost20MiB(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	huge := strings.Repeat("x", 50*1024*1024)
	if err := os.WriteFile(path, []byte(huge), 0o644); err != nil {
		t.Fatal(err)
	}

	var bytesRead int64
	tt := &Tailer{
		Open: func(p string) (io.ReadSeekCloser, error) {
			f, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			return &countingFile{File: f, n: &bytesRead}, nil
		},
	}
	if _, err := tt.Read(path, 0); err != nil {
		t.Fatal(err)
	}
	cap := int64(maxTickBytes + maxLineBytes) // 20 MiB
	if bytesRead > cap {
		t.Errorf("bytesRead = %d, want ≤ %d (io.LimitReader bound)", bytesRead, cap)
	}
}

func TestTailer_50MiBWhitespace_TickBudgetHitTrue(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	// 50 MiB of "\n" lines.
	var buf strings.Builder
	for i := 0; i < 50*1024; i++ {
		buf.WriteString(strings.Repeat("\n", 1024)) // 1 KiB of '\n's
	}
	if err := os.WriteFile(path, []byte(buf.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	r, err := tt.Read(path, 0)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !r.TickBudgetHit {
		t.Errorf("TickBudgetHit should be true on 50 MiB whitespace")
	}
	if len(r.Events) != 0 {
		t.Errorf("Events should be empty: %v", r.Events[:5])
	}
}
```

Note: `countingFile` embeds `*os.File` so the resulting type also satisfies `io.ReadSeekCloser` (via `*os.File`'s `Seek` and `Close` methods inherited through embedding).

- [ ] **Step 2: Verify all tail tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Tailer -v -race
```

Expected: 12 tail tests pass (7 from earlier + 5 here).

- [ ] **Step 3: Commit**

```bash
git add agent/watcher/tail_test.go
git commit -m "test(agent): tail oversize + TickBudgetHit + 20 MiB memory bound regressions"
```

---

## Phase 6 — `watcher/chunker` (PR2: 1 chunk per TailResult)

Minimal in PR2; PR3 evolves to gzip-size splitting.

### Task 6.1: Chunker.Split

**Files:**
- Create: `agent/watcher/chunker.go`
- Create: `agent/watcher/chunker_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/watcher/chunker_test.go`:

```go
package watcher

import (
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/sink"
)

func TestChunker_OneChunkPerNonEmptyTailResult(t *testing.T) {
	c := &Chunker{}
	ref := FileRef{
		Path:      "/x.jsonl",
		Source:    "claude",
		SessionID: "s1",
	}
	tr := TailResult{
		Events:     []string{`{"a":1}`, `{"b":2}`},
		FromOffset: 0,
		ToOffset:   16,
	}
	chunks := c.Split(ref, tr, "/Users/h/proj")
	if len(chunks) != 1 {
		t.Fatalf("got %d chunks, want 1", len(chunks))
	}
	got := chunks[0]
	want := sink.Chunk{
		File:       "/x.jsonl",
		Source:     "claude",
		SessionID:  "s1",
		CWD:        "/Users/h/proj",
		Events:     []string{`{"a":1}`, `{"b":2}`},
		FromOffset: 0,
		ToOffset:   16,
	}
	if got.File != want.File || got.Source != want.Source || got.SessionID != want.SessionID ||
		got.CWD != want.CWD || got.FromOffset != want.FromOffset || got.ToOffset != want.ToOffset {
		t.Errorf("got = %+v, want %+v", got, want)
	}
	if len(got.Events) != 2 || got.Events[0] != `{"a":1}` || got.Events[1] != `{"b":2}` {
		t.Errorf("Events mismatch: %v", got.Events)
	}
}

func TestChunker_EmptyTailResult_ZeroChunks(t *testing.T) {
	c := &Chunker{}
	tr := TailResult{FromOffset: 100, ToOffset: 100}
	chunks := c.Split(FileRef{}, tr, "")
	if len(chunks) != 0 {
		t.Errorf("got %d chunks, want 0", len(chunks))
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Chunker
```

Expected: FAIL — `Chunker` undefined.

- [ ] **Step 3: Implement `agent/watcher/chunker.go`**

```go
package watcher

import "github.com/hanfour/ai-dev-eval/agent/sink"

// Chunker splits a TailResult into one or more Chunks. PR2 emits exactly
// one Chunk per non-empty TailResult (or zero if no events). PR3 will
// split by gzipped size targeting ~1 MB per chunk while maintaining
// line-boundary FromOffset/ToOffset alignment.
type Chunker struct{}

func (c *Chunker) Split(ref FileRef, tr TailResult, cwd string) []sink.Chunk {
	if len(tr.Events) == 0 {
		return nil
	}
	return []sink.Chunk{{
		File:            ref.Path,
		Source:          ref.Source,
		SessionID:       ref.SessionID,
		ParentSessionID: ref.ParentSessionID,
		CWD:             cwd,
		Events:          tr.Events,
		FromOffset:      tr.FromOffset,
		ToOffset:        tr.ToOffset,
	}}
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Chunker -v
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/chunker.go agent/watcher/chunker_test.go
git commit -m "feat(agent): Chunker.Split — one chunk per non-empty TailResult"
```

---

## Phase 7 — `watcher/loop` (orchestrator)

The biggest single file in PR2. Two tasks: scaffold + Tick algorithm; then exercise every failure shape.

### Task 7.1: Loop scaffold + happy path

**Files:**
- Create: `agent/watcher/loop.go`
- Create: `agent/watcher/loop_test.go`

- [ ] **Step 1: Write the failing test (happy path only)**

Create `agent/watcher/loop_test.go`:

```go
package watcher

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/sink"
)

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
	l.lines = append(l.lines, formatFakeLog(format, args...))
}

func formatFakeLog(format string, args ...any) string {
	return sprintfWithArgs(format, args...)
}

// (use fmt.Sprintf — defined inline to keep the import list local; the
// real Logger interface uses Printf with format+args, and tests just
// need to inspect the resulting strings.)

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
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	// One claude file with content.
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
	// Verify state.json was persisted.
	loaded, err := config.LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Files[sess].Offset == 0 {
		t.Errorf("LoadState shows no advance: %+v", loaded.Files)
	}
}
```

Add a small helper at the bottom of the file (or inline in `formatFakeLog`) using `fmt.Sprintf`:

```go
import "fmt"

func sprintfWithArgs(format string, args ...any) string { return fmt.Sprintf(format, args...) }
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Loop_HappyPath
```

Expected: FAIL — `NewLoop` / `LoopOpts` undefined.

- [ ] **Step 3: Create `agent/watcher/loop.go`**

```go
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

// LoopOpts is the constructor argument. All fields are required except
// Resolver (defaults to a real CWDResolver) and Now (defaults to time.Now).
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

// Loop is the watcher main-loop orchestrator. NewLoop initialises the
// cwdCache; resolveCWDForRef also lazy-inits as defence against
// struct-literal construction in older tests.
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

// Run blocks until ctx.Done(). Returns ctx.Err() on cancellation.
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

// Tick performs a single iteration.
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
				wm.Offset = 0
				l.state.Files[ref.Path] = config.FileWatermark{Offset: 0, LastSync: l.now()}
				if err := config.SaveState(l.state); err != nil {
					l.log.Printf("[error] save state (shrink reset): %v", err)
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

			if tr.ToOffset == wm.Offset {
				continue
			}

			chunks := l.chunker.Split(ref, tr, cwd)
			if len(chunks) == 0 && tr.ToOffset > wm.Offset {
				// No-event consumed segment: advance watermark anyway.
				l.state.Files[ref.Path] = config.FileWatermark{Offset: tr.ToOffset, LastSync: l.now()}
				if err := config.SaveState(l.state); err != nil {
					l.log.Printf("[error] save state (no-event segment): %v", err)
				}
				continue
			}
			for _, c := range chunks {
				if ctx.Err() != nil {
					break SOURCELOOP
				}
				if err := l.sink.SendChunk(ctx, c); err != nil {
					l.log.Printf("[error] sink: %v", err)
					totalErrors++
					break // skip remaining chunks for THIS ref this tick
				}
				totalChunks++
				l.state.Files[c.File] = config.FileWatermark{Offset: c.ToOffset, LastSync: l.now()}
				if err := config.SaveState(l.state); err != nil {
					l.log.Printf("[error] save state: %v", err)
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

// resolveCWDForRef dispatches per-source. Codex sources pre-fill CWD;
// Claude sources need the resolver. Cached across ticks for Claude
// (cwds are immutable for a file's lifetime).
func (l *Loop) resolveCWDForRef(ref FileRef) (string, error) {
	if l.cwdCache == nil {
		l.cwdCache = make(map[string]string)
	}
	if ref.CWD != "" {
		l.cwdCache[ref.Path] = ref.CWD
		return ref.CWD, nil
	}
	// Claude: cache by the encoded-cwd dir (parent of the .jsonl, or
	// two parents up for a subagent file).
	claudeDir := filepath.Dir(ref.Path)
	if ref.Source == "claude-subagent" {
		// path is <root>/<encoded>/<sessionID>/subagents/agent-X.jsonl
		claudeDir = filepath.Dir(filepath.Dir(claudeDir))
	}
	if cached, ok := l.cwdCache[claudeDir]; ok && cached != "" {
		return cached, nil
	}
	cwd, err := l.resolver.ResolveClaude(claudeDir)
	if err != nil {
		return "", err
	}
	if cwd != "" {
		l.cwdCache[claudeDir] = cwd
	}
	return cwd, nil
}

// allowed reports whether cwd is under any path in the include list.
// A path "matches" if cwd == path or cwd starts with "<path>/".
func allowed(cwd string, includes []string) bool {
	for _, inc := range includes {
		if cwd == inc {
			return true
		}
		if strings.HasPrefix(cwd, inc+"/") {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Verify the happy-path test passes**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Loop_HappyPath -v -race
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/loop.go agent/watcher/loop_test.go
git commit -m "feat(agent): Loop.Tick orchestrator with happy-path coverage"
```

### Task 7.2: Loop failure-shape tests

**Files:**
- Modify: `agent/watcher/loop_test.go` (append all failure-mode tests)

- [ ] **Step 1: Append the failure tests**

Append to `agent/watcher/loop_test.go`:

```go
func TestLoop_AllowListFilter_SkipsNonMatchingRefs(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

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

func TestLoop_SinkError_StateUntouched(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
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
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte("{}"), 0o644) // 2 bytes, no '\n' — incomplete

	state := &config.State{Files: map[string]config.FileWatermark{
		sess: {Offset: 1000}, // pre-seed too-large offset
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
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	// Only whitespace lines.
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
	t.Setenv("CALIBER_AGENT_HOME", tmp)
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
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	os.WriteFile(sess, []byte(`{"a":1}`+"\n"), 0o644)

	resv := &fakeResolver{byDir: map[string]string{}} // returns ""
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
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)
	sess := filepath.Join(proj, "s.jsonl")
	// 5 MiB single oversize line + '\n' — no events
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

func TestLoop_SIGTERMMidTick_DrainsAndReturnsCtxErr(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	proj := filepath.Join(tmp, "claude-projects", "-Users-h-p")
	os.MkdirAll(proj, 0o755)

	ctx, cancel := context.WithCancel(context.Background())

	// Two refs; cancelling sink on first chunk should keep second from running.
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

// Suppress "unused import" if needed
var _ io.ReadCloser
```

- [ ] **Step 2: Verify all loop tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./watcher/... -run Loop -v -race
```

Expected: 9 loop tests pass.

- [ ] **Step 3: Commit**

```bash
git add agent/watcher/loop_test.go
git commit -m "test(agent): loop allow-list / sink-err / shrink / no-event / cwd-cache / SIGTERM"
```

---

## Phase 8 — `cli/run` (replace PR1 stub)

The `run` command wires config + keychain + sources + logger + sink into a `Loop`, then either runs `--once` or blocks until SIGTERM.

### Task 8.1: Replace the run stub

**Files:**
- Modify: `agent/internal/cli/run.go` (was: stub returning ExitNotImplemented)
- Create: `agent/internal/cli/run_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/cli/run_test.go`:

```go
package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
)

// setupEnrolledHome makes a tmp HOME with a valid config.toml and a fake
// keychain entry for the device id. Returns the home path.
func setupEnrolledHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)

	// Fake security CLI that succeeds on Get (writes the secret to stdout).
	scriptDir := t.TempDir()
	script := "#!/bin/sh\necho cda_dummy\n"
	scriptPath := filepath.Join(scriptDir, "security")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := keychain.SecurityBin
	keychain.SecurityBin = scriptPath
	t.Cleanup(func() { keychain.SecurityBin = orig })

	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin",
		APIBaseURL:   "http://localhost:3001",
		Mode:         "metadata-only",
		IncludePaths: []string{home + "/projects/allowed"},
	}); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestRun_NotEnrolled_ReturnsExit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
	if !strings.Contains(err.Error(), "not enrolled") {
		t.Errorf("expected 'not enrolled' in: %v", err)
	}
}

func TestRun_KeychainMissing_ReturnsExit1(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	// config exists, keychain doesn't
	if err := config.Save(&config.Config{DeviceID: "dev-x"}); err != nil {
		t.Fatal(err)
	}
	// fake security that exits 44 (not found)
	scriptDir := t.TempDir()
	script := "#!/bin/sh\nexit 44\n"
	scriptPath := filepath.Join(scriptDir, "security")
	os.WriteFile(scriptPath, []byte(script), 0o755)
	orig := keychain.SecurityBin
	keychain.SecurityBin = scriptPath
	t.Cleanup(func() { keychain.SecurityBin = orig })

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	err := cmd.ExecuteContext(context.Background())
	if err == nil || !strings.Contains(err.Error(), "device key missing") {
		t.Errorf("expected device-key-missing error, got %v", err)
	}
}

func TestRun_OnceWithEmptyAllowList_TicksAndExits(t *testing.T) {
	home := setupEnrolledHome(t)

	// CALIBER_CLAUDE_PROJECTS + CALIBER_CODEX_SESSIONS pointed at empty dirs.
	claudeRoot := filepath.Join(home, "claude-projects-empty")
	codexRoot := filepath.Join(home, "codex-sessions-empty")
	os.MkdirAll(claudeRoot, 0o755)
	os.MkdirAll(codexRoot, 0o755)
	t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
	t.Setenv("CALIBER_CODEX_SESSIONS", codexRoot)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v", err)
	}

	logPath := filepath.Join(home, "agent.log")
	bs, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read agent.log: %v", err)
	}
	if !strings.Contains(string(bs), "[tick-end]") {
		t.Errorf("agent.log missing [tick-end]: %q", bs)
	}
}

func TestRun_OnceWithMatchingFile_ProducesChunkLine(t *testing.T) {
	home := setupEnrolledHome(t)

	// Make the include_paths point to a real dir, and create a Claude
	// transcript whose cwd matches.
	allowed := filepath.Join(home, "projects", "allowed")
	os.MkdirAll(allowed, 0o755)
	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		IncludePaths: []string{allowed},
	}); err != nil {
		t.Fatal(err)
	}

	claudeRoot := filepath.Join(home, "claude-projects")
	t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
	t.Setenv("CALIBER_CODEX_SESSIONS", filepath.Join(home, "codex-empty"))
	os.MkdirAll(filepath.Join(home, "codex-empty"), 0o755)

	// Claude-encoded path corresponding to allowed dir (replace / with -)
	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(allowed, "/"), "/", "-")
	projDir := filepath.Join(claudeRoot, encoded)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Transcript with cwd field for the resolver.
	if err := os.WriteFile(filepath.Join(projDir, "sess.jsonl"),
		[]byte(`{"type":"user","cwd":"`+allowed+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v", err)
	}

	bs, err := os.ReadFile(filepath.Join(home, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bs), "[chunk]") {
		t.Errorf("agent.log missing [chunk] line: %q", bs)
	}
}

func TestRun_PersistentMode_TicksMultipleTimesUntilCancel(t *testing.T) {
	home := setupEnrolledHome(t)
	t.Setenv("CALIBER_CLAUDE_PROJECTS", filepath.Join(home, "c-empty"))
	t.Setenv("CALIBER_CODEX_SESSIONS", filepath.Join(home, "cx-empty"))
	os.MkdirAll(filepath.Join(home, "c-empty"), 0o755)
	os.MkdirAll(filepath.Join(home, "cx-empty"), 0o755)

	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--interval", "100ms"})

	err := cmd.ExecuteContext(ctx)
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		// Persistent mode returns context.Canceled or context.DeadlineExceeded.
		t.Errorf("expected ctx-cancel-style error, got %v", err)
	}

	bs, _ := os.ReadFile(filepath.Join(home, "agent.log"))
	// Should contain at least 2 [tick-end] lines (300 ms / 100 ms ≈ 3 ticks).
	if strings.Count(string(bs), "[tick-end]") < 2 {
		t.Errorf("expected multiple [tick-end] lines, got %q", bs)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/cli/... -run Run
```

Expected: FAIL — the existing `run` stub returns exit 64, not what these tests expect.

- [ ] **Step 3: Replace `agent/internal/cli/run.go`**

Replace the entire file:

```go
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/sink"
	"github.com/hanfour/ai-dev-eval/agent/watcher"
)

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
	cmd.Flags().DurationVar(&interval, "interval", 60*time.Second, "polling interval (advanced; default 60s)")
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
	logger := config.NewRFCLogger(io.MultiWriter(logFile, cmd.ErrOrStderr()))

	loop := watcher.NewLoop(watcher.LoopOpts{
		Sources: []watcher.Source{
			watcher.NewClaudeSource(claudeProjectsRoot()),
			watcher.NewCodexSource(codexSessionsRoot(), nil),
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

	if once {
		return loop.Tick(cmd.Context())
	}
	err = loop.Run(cmd.Context())
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		// SIGTERM / parent-ctx cancel = clean shutdown.
		return nil
	}
	return err
}

// codexSessionsRoot mirrors claudeProjectsRoot (from enroll.go). Test
// override via CALIBER_CODEX_SESSIONS.
func codexSessionsRoot() string {
	if override := os.Getenv("CALIBER_CODEX_SESSIONS"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex", "sessions")
}
```

Make sure the run command is registered in `root.go` — PR1's `New()` already added `newRunCmd()` for the stub; the file path change doesn't move the registration.

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go test ./internal/cli/... -v -race
```

Expected: all PR1 cli tests still pass; 5 new Run tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/run.go agent/internal/cli/run_test.go
git commit -m "feat(agent): cli.run wires watcher.Loop end-to-end with --once and --interval"
```

---

## Phase 9 — Smoke + coverage + PR

### Task 9.1: Smoke script

**Files:**
- Create: `agent/scripts/smoke-run.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Manual smoke for the daemon main loop.
# Prereq: caliber-agent enroll already succeeded against a running stack.
# Until `caliber-agent add-path` lands in PR4, hand-edit
#   ~/.caliber-agent/config.toml to add at least one path to include_paths.
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

- [ ] **Step 2: Make executable + commit**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2
chmod +x agent/scripts/smoke-run.sh
git add agent/scripts/smoke-run.sh
git commit -m "test(agent): manual smoke-run.sh for the daemon main loop"
```

### Task 9.2: Coverage gate + final test sweep

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go vet ./...
go test ./... -race -count=1
gofmt -l .
./scripts/coverage.sh
```

Expected: all green, gofmt clean, coverage ≥ 80%.

- [ ] **Step 2: If coverage < 80%, identify gaps**

```bash
go test ./internal/... ./watcher/... ./sink/... -race -coverprofile=cover-raw.out
grep -v "internal/wizard/prompt_huh.go" cover-raw.out > cover.out
go tool cover -func=cover.out | sort -k 3 -n | head -20
```

The lowest-covered functions are likely candidates for one-line tests (e.g. `defaultStat` happy path or a no-op trivial helper). Add a handful of targeted tests if needed. **If coverage is already ≥ 80%, skip this step.**

- [ ] **Step 3: Commit coverage tweaks (only if Step 2 added anything)**

```bash
git add agent/...
git commit -m "test(agent): fill coverage gaps to clear 80% gate"
```

### Task 9.3: Local partial smoke (no real token needed)

- [ ] **Step 1: Verify the binary builds and `run --once` works without ingest**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2/agent
go build -o /tmp/ca ./cmd/caliber-agent
/tmp/ca version
# expect: dev (unknown, unknown)
/tmp/ca run --once 2>&1 | head -5
# expect: device not enrolled message (because tmp $CALIBER_AGENT_HOME is empty)
rm /tmp/ca
```

This is the "binary built; CLI works" sanity check. Full end-to-end smoke (real enrollment token + watcher → log) needs the PR1-enrolled state and is the human's job after merge.

### Task 9.4: Push + open PR

- [ ] **Step 1: Push the branch**

```bash
cd /Users/hanfourhuang/ai-dev-eval/.claude/worktrees/feat-caliber-agent-phase2-pr2
git push -u origin feat/caliber-agent-phase2-pr2
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base feat/caliber-agent-phase2-pr1 --head feat/caliber-agent-phase2-pr2 \
  --title "feat(agent): Phase 2 PR2 — watcher + stub-sink + run command" \
  --body "$(cat <<'EOF'
## Summary

caliber-agent Phase 2 PR2 — the daemon's main loop. `caliber-agent run` polls `~/.claude/projects/` and `~/.codex/sessions/` every 60 seconds, tails new bytes per transcript, splits them into chunks, and delivers each chunk to a `Sink`. PR2 ships a stub `LogSink` writing metadata-only lines to `~/.caliber-agent/agent.log`; PR3 will swap in the real HTTP ingest client.

## What landed

- **`caliber-agent run`** with `--once` (single-tick smoke) and `--interval` (test) flags
- **`watcher` package**: `Source` interface + `ClaudeSource` (main + subagents) + `CodexSource` (with 64 KiB-bounded session_meta cwd read) + `Tailer` (ReadSlice loop, hard 20 MiB I/O cap via `io.LimitReader`, oversize-line drop with forward progress, three-state EOF precedence) + `Chunker` + `Loop` orchestrator
- **`sink` package**: `Chunk` type and `Sink` interface frozen at this PR for PR3 to swap; `LogSink` stub with privacy + failing-writer regression guards
- **`config.OpenAgentLog` + `config.RFCLogger`**: agent.log management at 0600 append-mode with UTC-RFC3339 line format (replaces stdlib's `YYYY/MM/DD HH:MM:SS`)
- **`cwdresolve` package**: extracted from wizard so the watcher's `CWDResolver` and the wizard's enrollment scan share one algorithm

## Design doc

`docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md` — went through 7 rounds of review covering Codex cwd contract, oversize/EOF precedence, memory bound semantics, no-event watermark advance, RFC3339 logger, TickBudgetHit unconditionality, and other subtleties.

## Implementation plan

`docs/superpowers/plans/2026-05-22-caliber-agent-phase2-pr2.md` — 9 phases / 19 tasks / 70+ TDD steps executed via subagent-driven development.

## Out of scope (deferred)

| Item | Future PR |
|---|---|
| `POST /v1/ingest` HTTP client + gzip + retry/backoff | PR3 |
| Redaction layer (metadata-only / redacted-body / full-body) | PR3 |
| Per-org redaction set fetch | PR3 |
| launchd plist + `install-launchd` | PR4 |
| Real implementations of stubbed commands (status/pause/etc.) | PR4+ |
| Homebrew tap push automation | PR4 |
| Linux build target | Phase 5+ |
| `agent.log` rotation | Phase 3 |

## Test plan

- [x] `go test ./internal/... ./watcher/... ./sink/... -race` — all pass
- [x] `./scripts/coverage.sh` — ≥ 80% gate clears
- [x] `go vet ./...` and `gofmt -l .` clean
- [x] Local partial smoke: `/tmp/ca run --once` correctly reports "device not enrolled" on empty home
- [ ] **Pending user verification**: full end-to-end smoke against a real enrolled daemon. Add at least one path to `~/.caliber-agent/config.toml include_paths` (via hand-edit until PR4 lands `add-path`), then `./agent/scripts/smoke-run.sh`. Expected: `[chunk]` line(s) in agent.log + advanced offsets in state.json.

## Stacked

This PR is stacked **on `feat/caliber-agent-phase2-pr1` (#160)**, which is itself stacked on `fix/api-enrollment-race` (#159). Merge order: #159 → #160 → this. GitHub will auto-retarget bases as parents land.
EOF
)"
```

- [ ] **Step 3: Return the PR URL**

---

## Self-Review

Run this checklist with fresh eyes against `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr2-design.md`:

**Spec coverage**

- §1 Goal: Phase 8 Task 8.1 wires the binary's `run` command end-to-end ✓
- §2 Non-goals: every item maps to a future PR in the PR-body table ✓
- §3 Layout: every new file listed in the spec is created in one of Phases 1–8 ✓
- §4.1 Chunk type: Task 1.1 ✓
- §4.2 Sink interface + LogSink: Task 1.2 ✓
- §4.3 FileRef + Source: Task 3.1 ✓
- §4.4 ClaudeSource: Task 3.2 (including canonical-id contract test cases for subagent SessionID derivation) ✓
- §4.5 CodexSource: Task 3.3 (including the 64 KiB bound test for malformed session_meta) ✓
- §4.6 Tailer: Tasks 5.1–5.3 (skeleton + happy paths + oversize/TickBudgetHit) ✓
- §4.7 Chunker: Task 6.1 ✓
- §4.8 CWDResolver: Task 4.2 (wraps cwdresolve extracted in Task 4.1) ✓
- §4.9 Loop: Tasks 7.1 (happy path) + 7.2 (all failure shapes) ✓
- §4.10 OpenAgentLog + RFCLogger: Tasks 2.1 + 2.2 ✓
- §4.11 cli/run: Task 8.1 ✓
- §5 Data flow / failure shapes: covered by Phase 7 failure tests (A/B/C/D/F + B' shrink-to-empty implicit in `TestLoop_FileShrank_PersistsResetBeforeRetail`)
- §6 Error handling principles: enforced by the loop algorithm + tests
- §7 Testing matrix: every package's test list is realized
- §8 Public contract: `--once`, `--interval`, `CALIBER_CODEX_SESSIONS`, agent.log path/mode, state.json semantics all touched
- §9a server prereq: not applicable (PR2 is stacked on PR1 which already shipped that fix)

**Placeholder scan** — searched for "TBD", "TODO", "Add appropriate", "Similar to" — none present.

**Type consistency** — Chunk fields stable across §4.1, Task 1.1, Task 6.1, Task 7.1 ✓; `TailResult` fields stable from skeleton (Task 5.1) through full impl (Task 5.2/5.3); `Logger` interface defined once in Task 7.1 and consumed by Task 8.1.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-caliber-agent-phase2-pr2.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between phases, fast iteration.

**2. Inline Execution** — execute in this session with checkpoints for review.

**Which approach?**
