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

	write(t, filepath.Join(root, "2026", "05", "21", "not-a-rollout.txt"), "x")
	write(t, filepath.Join(root, "not-a-date-dir", "x.jsonl"), "{}")

	s := NewCodexSource(root, nil)
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

func TestCodexSource_List_SkipsSymlinkedJsonl(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "2026", "05", "27")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	// real
	uuid := "11111111-2222-3333-4444-555555555555"
	real := filepath.Join(deep, "rollout-"+uuid+".jsonl")
	if err := os.WriteFile(real, []byte(`{"payload":{"cwd":"/home/u"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// symlink
	uuid2 := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	sym := filepath.Join(deep, "rollout-"+uuid2+".jsonl")
	if err := os.Symlink("/etc/passwd", sym); err != nil {
		t.Fatal(err)
	}

	src := NewCodexSource(root, nil)
	refs, err := src.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, r := range refs {
		if filepath.Base(r.Path) == filepath.Base(sym) {
			t.Fatalf("symlink must be skipped, found %s", r.Path)
		}
	}
	if len(refs) != 1 {
		t.Fatalf("expected 1 real ref, got %d", len(refs))
	}
}

func TestCodexSource_ReadCWD_SymlinkReturnsEmpty(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "2026", "05", "27")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	// Symlink target is a real file with a parseable cwd; without the
	// Lstat guard readCWD would happily follow the link and return the
	// attacker-supplied cwd.
	target := filepath.Join(root, "target.jsonl")
	if err := os.WriteFile(target, []byte(`{"payload":{"cwd":"/etc"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sym := filepath.Join(deep, "rollout-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")
	if err := os.Symlink(target, sym); err != nil {
		t.Fatal(err)
	}
	src := NewCodexSource(root, nil)
	if cwd := src.readCWD(sym); cwd != "" {
		t.Fatalf("readCWD on symlink must return empty, got %q", cwd)
	}
}

func TestCodexSource_64KiBBound_OnUnboundedMalformedFirstLine(t *testing.T) {
	root := t.TempDir()
	uuidX := "019ddead-0000-0000-0000-000000000002"
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
