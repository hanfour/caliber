package watcher

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCWDResolver_PassesThroughToPackage(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "proj")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// cwdresolve canonicalises via EvalSymlinks.
	wantCWD, err := filepath.EvalSymlinks(realDir)
	if err != nil {
		t.Fatal(err)
	}

	// Claude-encoded dir name: leading "-" + dashes for slashes.
	encoded := "-" + strings.TrimPrefix(strings.ReplaceAll(realDir, "/", "-"), "-")
	claudeDir := filepath.Join(tmp, "claude-projects", encoded)
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Empty dir (no JSONL) → forces dirname-fallback path which should
	// resolve back to realDir via stat-guided decode.
	r := NewCWDResolver(nil)
	got, err := r.ResolveClaude(claudeDir)
	if err != nil {
		t.Fatalf("ResolveClaude: %v", err)
	}
	if got != wantCWD {
		t.Errorf("got %q, want %q", got, wantCWD)
	}
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
	// Just verify Open is wired through without panic. Behavioural
	// correctness is covered by the wizard's existing tests for
	// cwdresolve.
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
