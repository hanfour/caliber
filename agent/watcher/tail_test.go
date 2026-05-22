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
	_, err := tt.Read(path, 10000)
	if !errors.Is(err, ErrFileShrank) {
		t.Fatalf("err = %v, want ErrFileShrank", err)
	}
}

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
	r, err := tt.Read(path, 8)
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
	r, err := tt.Read(path, 6)
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

func TestTailer_Oversize_Completed_DropsAndAdvances(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
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
	huge := strings.Repeat("x", 50*1024*1024)
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
	capBytes := int64(maxTickBytes + maxLineBytes)
	if bytesRead > capBytes {
		t.Errorf("bytesRead = %d, want ≤ %d (io.LimitReader bound)", bytesRead, capBytes)
	}
}

func TestTailer_50MiBWhitespace_TickBudgetHitTrue(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	var buf strings.Builder
	for i := 0; i < 50*1024; i++ {
		buf.WriteString(strings.Repeat("\n", 1024))
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
